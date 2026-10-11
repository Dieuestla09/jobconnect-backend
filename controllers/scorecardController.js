const pool = require('../config/db');

const RECOMMENDATIONS = ['Strong yes', 'Yes', 'Maybe', 'No'];
const MAX_NOTES = 2000;

const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// Accept 1-5 as a number or a digit string; reject 0, 6, 3.5, "", null, true...
const rating = (value) => {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
  }
  return null;
};

const validateScorecard = (body) => {
  const errors = [];
  const technical = rating(body.technical);
  const communication = rating(body.communication);
  const cultureFit = rating(body.culture_fit);
  if (technical === null) errors.push('Technical rating must be a whole number from 1 to 5');
  if (communication === null) errors.push('Communication rating must be a whole number from 1 to 5');
  if (cultureFit === null) errors.push('Culture fit rating must be a whole number from 1 to 5');
  if (!RECOMMENDATIONS.includes(body.recommendation)) {
    errors.push(`Recommendation must be one of: ${RECOMMENDATIONS.join(', ')}`);
  }
  let notes = null;
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') {
      errors.push('Notes must be text');
    } else if (body.notes.length > MAX_NOTES) {
      errors.push(`Notes must be ${MAX_NOTES} characters or fewer`);
    } else {
      notes = body.notes.trim() || null;
    }
  }
  return {
    errors,
    values: { technical, communication, culture_fit: cultureFit, recommendation: body.recommendation, notes }
  };
};

const scorecardColumns = `scorecards.id, scorecards.application_id, scorecards.reviewer_id, scorecards.technical,
  scorecards.communication, scorecards.culture_fit, scorecards.recommendation, scorecards.notes,
  scorecards.overall, scorecards.created_at, scorecards.updated_at`;

// 404 if the application is missing, 403 unless this employer owns the job (admins may read any).
const loadApplicationForReview = async (req, res) => {
  const id = toId(req.params.applicationId);
  if (!id) {
    res.status(400).json({ message: 'Invalid application id' });
    return null;
  }
  const [rows] = await pool.query(
    `SELECT applications.id, applications.job_id, jobs.employer_id
     FROM applications JOIN jobs ON jobs.id = applications.job_id WHERE applications.id = ? LIMIT 1`,
    [id]
  );
  if (!rows.length) {
    res.status(404).json({ message: 'Application not found' });
    return null;
  }
  if (req.user.role !== 'admin' && rows[0].employer_id !== req.user.id) {
    res.status(403).json({ message: 'You can only use scorecards for applicants of your own jobs' });
    return null;
  }
  return rows[0];
};

const getScorecard = async (req, res) => {
  try {
    const application = await loadApplicationForReview(req, res);
    if (!application) return;
    const [rows] = await pool.query(`SELECT ${scorecardColumns} FROM scorecards WHERE application_id = ? LIMIT 1`, [
      application.id
    ]);
    res.json({ scorecard: rows[0] || null });
  } catch (error) {
    res.status(500).json({ message: 'Could not load scorecard', error: error.message });
  }
};

// Create or replace the single scorecard for an application.
const saveScorecard = async (req, res) => {
  try {
    const application = await loadApplicationForReview(req, res);
    if (!application) return;
    const { errors, values } = validateScorecard(req.body || {});
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    // `overall` is a generated column: the database works it out, we never send it.
    const [result] = await pool.query(
      `INSERT INTO scorecards (application_id, reviewer_id, technical, communication, culture_fit, recommendation, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         reviewer_id = VALUES(reviewer_id), technical = VALUES(technical), communication = VALUES(communication),
         culture_fit = VALUES(culture_fit), recommendation = VALUES(recommendation), notes = VALUES(notes)`,
      [
        application.id,
        req.user.id,
        values.technical,
        values.communication,
        values.culture_fit,
        values.recommendation,
        values.notes
      ]
    );
    const [rows] = await pool.query(`SELECT ${scorecardColumns} FROM scorecards WHERE application_id = ? LIMIT 1`, [
      application.id
    ]);
    // affectedRows is 1 for a new row and 2 when an existing row was changed.
    res
      .status(result.affectedRows === 1 ? 201 : 200)
      .json({ message: result.affectedRows === 1 ? 'Scorecard saved' : 'Scorecard updated', scorecard: rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Could not save scorecard', error: error.message });
  }
};

// All scorecards for one job; ?rank=1 orders them best overall first (used by the applicants page).
const jobScorecards = async (req, res) => {
  const jobId = toId(req.params.jobId);
  if (!jobId) return res.status(400).json({ message: 'Invalid job id' });
  try {
    const [jobs] = await pool.query('SELECT employer_id FROM jobs WHERE id = ? LIMIT 1', [jobId]);
    if (!jobs.length) return res.status(404).json({ message: 'Job not found' });
    if (req.user.role !== 'admin' && jobs[0].employer_id !== req.user.id) {
      return res.status(403).json({ message: 'You can only view scorecards for your own jobs' });
    }
    const ranked = req.query.rank === '1' || req.query.rank === 'true';
    const [rows] = await pool.query(
      `SELECT ${scorecardColumns} FROM scorecards
       JOIN applications ON applications.id = scorecards.application_id
       WHERE applications.job_id = ?
       ORDER BY ${ranked ? 'scorecards.overall DESC, scorecards.technical DESC,' : ''} scorecards.id`,
      [jobId]
    );
    res.json({ scorecards: rows });
  } catch (error) {
    res.status(500).json({ message: 'Could not load scorecards', error: error.message });
  }
};

module.exports = { getScorecard, saveScorecard, jobScorecards, validateScorecard };
