const pool = require('../config/db');
const { matchesCriteria } = require('../services/alertMatcher');
const { loadOpenJobs, loadProfile, loadAppliedJobIds, rankJobs } = require('../services/matching');

const MAX_ALERTS = 10;
const MAX_MATCHES = 50;
const JOB_TYPES = ['Full-time', 'Part-time', 'Contract', 'Internship', 'Remote'];

const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// Validate and normalise the request body. Returns { errors, values }.
const validateAlert = (body) => {
  const errors = [];
  const text = (value) => (value === undefined || value === null ? '' : String(value).trim());
  const keywords = text(body.keywords);
  const location = text(body.location);
  const jobType = text(body.job_type) || null;
  let name = text(body.name);

  if (keywords.length > 200) errors.push('Keywords must be 200 characters or fewer');
  if (location.length > 160) errors.push('Location must be 160 characters or fewer');
  if (name.length > 100) errors.push('Alert name must be 100 characters or fewer');
  if (jobType && !JOB_TYPES.includes(jobType)) errors.push(`Job type must be one of: ${JOB_TYPES.join(', ')}`);
  if (!keywords && !location && !jobType) {
    errors.push('Add at least one keyword, a location or a job type');
  }

  const minMatch = body.min_match === undefined || body.min_match === '' ? 50 : Number(body.min_match);
  if (!Number.isInteger(minMatch) || minMatch < 0 || minMatch > 100) {
    errors.push('Minimum match must be a whole number from 0 to 100');
  }

  let isActive = 1;
  if (body.is_active !== undefined) {
    if (![true, false, 0, 1, '0', '1', 'true', 'false'].includes(body.is_active)) {
      errors.push('is_active must be true or false');
    } else {
      isActive = body.is_active === true || body.is_active === 1 || body.is_active === '1' || body.is_active === 'true' ? 1 : 0;
    }
  }

  if (!name) name = (keywords || location || jobType || 'My alert').slice(0, 100);
  return { errors, values: { name, keywords, location, job_type: jobType, min_match: minMatch, is_active: isActive } };
};

const presentAlert = (row) => ({ ...row, is_active: !!row.is_active });

// Loads an alert and enforces ownership: 404 if it does not exist, 403 if it is someone else's.
const loadOwnedAlert = async (req, res) => {
  const id = toId(req.params.id);
  if (!id) {
    res.status(400).json({ message: 'Invalid alert id' });
    return null;
  }
  const [rows] = await pool.query('SELECT * FROM job_alerts WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) {
    res.status(404).json({ message: 'Alert not found' });
    return null;
  }
  if (rows[0].user_id !== req.user.id) {
    res.status(403).json({ message: 'You can only manage your own alerts' });
    return null;
  }
  return rows[0];
};

// The jobs that pass an alert's filters and reach its minimum match %, best first.
const computeMatches = (alert, profile, openJobs) =>
  rankJobs(
    profile,
    openJobs.filter((job) => matchesCriteria(alert, job))
  ).filter((item) => item.match.score >= alert.min_match);

const listAlerts = async (req, res) => {
  try {
    const [alerts] = await pool.query('SELECT * FROM job_alerts WHERE user_id = ? ORDER BY created_at DESC, id DESC', [
      req.user.id
    ]);
    // Counts are computed live so they always reflect today's jobs and the current profile.
    const [profile, openJobs] = await Promise.all([loadProfile(req.user.id), loadOpenJobs()]);
    res.json({
      max_alerts: MAX_ALERTS,
      alerts: alerts.map((alert) => ({
        ...presentAlert(alert),
        match_count: computeMatches(alert, profile, openJobs).length
      }))
    });
  } catch (error) {
    res.status(500).json({ message: 'Could not load alerts', error: error.message });
  }
};

const createAlert = async (req, res) => {
  const { errors, values } = validateAlert(req.body || {});
  if (errors.length) return res.status(400).json({ message: errors[0], errors });

  try {
    // The cap is checked in the same statement that inserts, so two quick requests cannot both slip past it.
    const [result] = await pool.query(
      `INSERT INTO job_alerts (user_id, name, keywords, location, job_type, min_match, is_active)
       SELECT ?, ?, ?, ?, ?, ?, ? FROM DUAL
       WHERE (SELECT COUNT(*) FROM job_alerts WHERE user_id = ?) < ?`,
      [
        req.user.id,
        values.name,
        values.keywords,
        values.location,
        values.job_type,
        values.min_match,
        values.is_active,
        req.user.id,
        MAX_ALERTS
      ]
    );
    if (!result.affectedRows) {
      return res.status(409).json({ message: `You can save at most ${MAX_ALERTS} alerts. Delete one first.` });
    }
    const [rows] = await pool.query('SELECT * FROM job_alerts WHERE id = ?', [result.insertId]);
    res.status(201).json({ message: 'Alert saved', alert: presentAlert(rows[0]) });
  } catch (error) {
    res.status(500).json({ message: 'Could not save alert', error: error.message });
  }
};

const updateAlert = async (req, res) => {
  try {
    const alert = await loadOwnedAlert(req, res);
    if (!alert) return;
    const { errors, values } = validateAlert({ is_active: alert.is_active, ...req.body });
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    await pool.query(
      `UPDATE job_alerts SET name = ?, keywords = ?, location = ?, job_type = ?, min_match = ?, is_active = ?
       WHERE id = ?`,
      [values.name, values.keywords, values.location, values.job_type, values.min_match, values.is_active, alert.id]
    );
    const [rows] = await pool.query('SELECT * FROM job_alerts WHERE id = ?', [alert.id]);
    res.json({ message: 'Alert updated', alert: presentAlert(rows[0]) });
  } catch (error) {
    res.status(500).json({ message: 'Could not update alert', error: error.message });
  }
};

// Pause / resume without resending the whole alert.
const setAlertStatus = async (req, res) => {
  const value = req.body && req.body.is_active;
  if (typeof value !== 'boolean') {
    return res.status(400).json({ message: 'is_active must be true or false' });
  }
  try {
    const alert = await loadOwnedAlert(req, res);
    if (!alert) return;
    await pool.query('UPDATE job_alerts SET is_active = ? WHERE id = ?', [value ? 1 : 0, alert.id]);
    const [rows] = await pool.query('SELECT * FROM job_alerts WHERE id = ?', [alert.id]);
    res.json({ message: value ? 'Alert resumed' : 'Alert paused', alert: presentAlert(rows[0]) });
  } catch (error) {
    res.status(500).json({ message: 'Could not change alert status', error: error.message });
  }
};

const deleteAlert = async (req, res) => {
  try {
    const alert = await loadOwnedAlert(req, res);
    if (!alert) return;
    await pool.query('DELETE FROM job_alerts WHERE id = ?', [alert.id]);
    res.json({ message: 'Alert deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Could not delete alert', error: error.message });
  }
};

const alertMatches = async (req, res) => {
  try {
    const alert = await loadOwnedAlert(req, res);
    if (!alert) return;
    const [profile, openJobs, applied] = await Promise.all([
      loadProfile(req.user.id),
      loadOpenJobs(),
      loadAppliedJobIds(req.user.id)
    ]);
    const all = computeMatches(alert, profile, openJobs);
    res.json({
      alert: presentAlert(alert),
      profile_has_skills: !!(profile && profile.skills && profile.skills.trim()),
      total: all.length,
      matches: all.slice(0, MAX_MATCHES).map(({ job, match }) => ({ job, match, applied: applied.has(job.id) }))
    });
  } catch (error) {
    res.status(500).json({ message: 'Could not compute matches', error: error.message });
  }
};

module.exports = {
  listAlerts,
  createAlert,
  updateAlert,
  setAlertStatus,
  deleteAlert,
  alertMatches,
  validateAlert,
  MAX_ALERTS
};
