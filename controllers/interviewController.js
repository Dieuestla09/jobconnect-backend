const pool = require('../config/db');

const FORMATS = ['Video call', 'Phone', 'On-site'];
const MAX_SLOTS = 3;
const MAX_DAYS_AHEAD = 365;

const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// Check a proposal body. Returns { errors, values } where values.slots are Date objects.
const validateProposal = (body, now = Date.now()) => {
  const errors = [];
  const applicationId = toId(body.application_id);
  const format = typeof body.format === 'string' ? body.format : '';
  const venue = typeof body.venue === 'string' ? body.venue.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';

  if (!applicationId) errors.push('A valid application_id is required');
  if (!FORMATS.includes(format)) errors.push(`Format must be one of: ${FORMATS.join(', ')}`);
  if (venue.length < 3 || venue.length > 255) errors.push('Venue or meeting link must be 3 to 255 characters');
  if (note.length > 500) errors.push('Note must be 500 characters or fewer');

  const slots = [];
  if (!Array.isArray(body.slots) || body.slots.length < 1 || body.slots.length > MAX_SLOTS) {
    errors.push(`Propose between 1 and ${MAX_SLOTS} time slots`);
  } else {
    const seen = new Set();
    body.slots.forEach((raw) => {
      const date = typeof raw === 'string' ? new Date(raw) : null;
      if (!date || Number.isNaN(date.getTime())) {
        errors.push('Every slot must be a valid date and time');
        return;
      }
      // Interviews start on the minute; this also stops 10:00:00.1 and 10:00:00.9 counting as different slots.
      date.setSeconds(0, 0);
      if (date.getTime() <= now) {
        errors.push('Every slot must be in the future');
      } else if (date.getTime() > now + MAX_DAYS_AHEAD * 24 * 3600 * 1000) {
        errors.push(`Slots must be within the next ${MAX_DAYS_AHEAD} days`);
      } else if (seen.has(date.getTime())) {
        errors.push('Time slots must be different from each other');
      } else {
        seen.add(date.getTime());
        slots.push(date);
      }
    });
  }
  return { errors: Array.from(new Set(errors)), values: { applicationId, format, venue, note: note || null, slots } };
};

// Interviews with their job/candidate context and slots, for any WHERE clause.
const loadInterviews = async (where, params) => {
  const [interviews] = await pool.query(
    `SELECT interviews.id, interviews.application_id, interviews.format, interviews.venue, interviews.note,
            interviews.status, interviews.decline_reason, interviews.created_at, interviews.updated_at,
            jobs.id AS job_id, jobs.title AS job_title, jobs.employer_id,
            employer_profiles.company_name,
            applications.job_seeker_id, users.name AS candidate_name, users.email AS candidate_email
     FROM interviews
     JOIN applications ON applications.id = interviews.application_id
     JOIN jobs ON jobs.id = applications.job_id
     JOIN users ON users.id = applications.job_seeker_id
     LEFT JOIN employer_profiles ON employer_profiles.user_id = jobs.employer_id
     WHERE ${where}
     ORDER BY interviews.created_at DESC, interviews.id DESC`,
    params
  );
  if (!interviews.length) return [];
  const [slots] = await pool.query(
    'SELECT id, interview_id, starts_at, is_selected FROM interview_slots WHERE interview_id IN (?) ORDER BY starts_at',
    [interviews.map((interview) => interview.id)]
  );
  return interviews.map((interview) => ({
    ...interview,
    slots: slots
      .filter((slot) => slot.interview_id === interview.id)
      .map((slot) => ({ id: slot.id, starts_at: slot.starts_at, is_selected: !!slot.is_selected }))
  }));
};

const proposeInterview = async (req, res) => {
  const { errors, values } = validateProposal(req.body || {});
  if (errors.length) return res.status(400).json({ message: errors[0], errors });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // FOR UPDATE locks the application row, so two simultaneous proposals are handled one after the other.
    const [applications] = await connection.query(
      `SELECT applications.id, applications.status, jobs.employer_id
       FROM applications JOIN jobs ON jobs.id = applications.job_id
       WHERE applications.id = ? FOR UPDATE`,
      [values.applicationId]
    );
    if (!applications.length) {
      await connection.rollback();
      return res.status(404).json({ message: 'Application not found' });
    }
    if (applications[0].employer_id !== req.user.id) {
      await connection.rollback();
      return res.status(403).json({ message: 'You can only schedule interviews for applicants of your own jobs' });
    }
    if (applications[0].status !== 'Shortlisted') {
      await connection.rollback();
      return res.status(409).json({ message: 'Only shortlisted applicants can be invited to an interview' });
    }

    let interviewId;
    try {
      const [result] = await connection.query(
        `INSERT INTO interviews (application_id, scheduled_by, format, venue, note, status)
         VALUES (?, ?, ?, ?, ?, 'Proposed')`,
        [values.applicationId, req.user.id, values.format, values.venue, values.note]
      );
      interviewId = result.insertId;
    } catch (error) {
      // uq_interviews_one_active: this application already has a Proposed or Confirmed interview.
      if (error.code === 'ER_DUP_ENTRY') {
        await connection.rollback();
        return res.status(409).json({
          message: 'This applicant already has an active interview. Cancel it before proposing a new one.'
        });
      }
      throw error;
    }

    await connection.query('INSERT INTO interview_slots (interview_id, starts_at) VALUES ?', [
      values.slots.map((date) => [interviewId, date])
    ]);
    await connection.commit();

    const [interview] = await loadInterviews('interviews.id = ?', [interviewId]);
    res.status(201).json({ message: 'Interview proposed', interview });
  } catch (error) {
    await connection.rollback().catch(() => {});
    res.status(500).json({ message: 'Could not schedule interview', error: error.message });
  } finally {
    connection.release();
  }
};

// Role-aware list: seekers see their own, employers see interviews for their jobs, admins see all (read-only).
const listInterviews = async (req, res) => {
  try {
    const filters = ['1 = 1'];
    const params = [];
    if (req.user.role === 'job_seeker') {
      filters.push('applications.job_seeker_id = ?');
      params.push(req.user.id);
    } else if (req.user.role === 'employer') {
      filters.push('jobs.employer_id = ?');
      params.push(req.user.id);
    }
    if (req.query.job_id !== undefined) {
      const jobId = toId(req.query.job_id);
      if (!jobId) return res.status(400).json({ message: 'Invalid job_id' });
      filters.push('jobs.id = ?');
      params.push(jobId);
    }
    res.json({ interviews: await loadInterviews(filters.join(' AND '), params) });
  } catch (error) {
    res.status(500).json({ message: 'Could not load interviews', error: error.message });
  }
};

// Shared start of confirm/decline/cancel: lock the interview row and check who is asking.
// Returns the locked row, or null after sending the error response.
const lockInterview = async (connection, req, res, who) => {
  const id = toId(req.params.id);
  if (!id) {
    res.status(400).json({ message: 'Invalid interview id' });
    return null;
  }
  const [rows] = await connection.query(
    `SELECT interviews.*, applications.job_seeker_id, jobs.employer_id
     FROM interviews
     JOIN applications ON applications.id = interviews.application_id
     JOIN jobs ON jobs.id = applications.job_id
     WHERE interviews.id = ? FOR UPDATE`,
    [id]
  );
  if (!rows.length) {
    res.status(404).json({ message: 'Interview not found' });
    return null;
  }
  const owner = who === 'candidate' ? rows[0].job_seeker_id : rows[0].employer_id;
  if (owner !== req.user.id) {
    res.status(403).json({
      message:
        who === 'candidate'
          ? 'Only the invited candidate can respond to this interview'
          : 'You can only cancel interviews for your own jobs'
    });
    return null;
  }
  return rows[0];
};

const respond = async (req, res, who, action) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const interview = await lockInterview(connection, req, res, who);
    if (!interview) {
      await connection.rollback();
      return;
    }
    const outcome = await action(connection, interview);
    if (outcome.error) {
      await connection.rollback();
      return res.status(outcome.status).json({ message: outcome.error });
    }
    await connection.commit();
    const [updated] = await loadInterviews('interviews.id = ?', [interview.id]);
    res.json({ message: outcome.message, interview: updated });
  } catch (error) {
    await connection.rollback().catch(() => {});
    res.status(500).json({ message: 'Could not update interview', error: error.message });
  } finally {
    connection.release();
  }
};

const confirmInterview = (req, res) =>
  respond(req, res, 'candidate', async (connection, interview) => {
    if (interview.status !== 'Proposed') {
      return { status: 409, error: `This interview is already ${interview.status.toLowerCase()}` };
    }
    const slotId = toId(req.body && req.body.slot_id);
    if (!slotId) return { status: 400, error: 'Choose one of the proposed time slots' };

    const [slots] = await connection.query('SELECT id, starts_at FROM interview_slots WHERE id = ? AND interview_id = ?', [
      slotId,
      interview.id
    ]);
    if (!slots.length) return { status: 400, error: 'That slot does not belong to this interview' };
    if (new Date(slots[0].starts_at).getTime() <= Date.now()) {
      return { status: 409, error: 'That time slot has already passed' };
    }

    await connection.query('UPDATE interview_slots SET is_selected = 1 WHERE id = ?', [slotId]);
    await connection.query("UPDATE interviews SET status = 'Confirmed' WHERE id = ?", [interview.id]);
    return { message: 'Interview confirmed' };
  });

const declineInterview = (req, res) =>
  respond(req, res, 'candidate', async (connection, interview) => {
    const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 3 || reason.length > 500) {
      return { status: 400, error: 'Give a reason of 3 to 500 characters' };
    }
    if (interview.status !== 'Proposed') {
      return { status: 409, error: `This interview is already ${interview.status.toLowerCase()}` };
    }
    await connection.query("UPDATE interviews SET status = 'Declined', decline_reason = ? WHERE id = ?", [
      reason,
      interview.id
    ]);
    return { message: 'Interview declined' };
  });

const cancelInterview = (req, res) =>
  respond(req, res, 'employer', async (connection, interview) => {
    if (!['Proposed', 'Confirmed'].includes(interview.status)) {
      return { status: 409, error: `This interview is already ${interview.status.toLowerCase()}` };
    }
    await connection.query("UPDATE interviews SET status = 'Cancelled' WHERE id = ?", [interview.id]);
    return { message: 'Interview cancelled' };
  });

module.exports = {
  proposeInterview,
  listInterviews,
  confirmInterview,
  declineInterview,
  cancelInterview,
  validateProposal
};
