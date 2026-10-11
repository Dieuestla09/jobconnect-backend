const pool = require('../config/db');
const { scoreJob } = require('./matchScore');

// Database helpers shared by the alert and recommendation controllers.

const loadOpenJobs = async () => {
  const [jobs] = await pool.query(
    `SELECT jobs.*, employer_profiles.company_name, users.name AS employer_name
     FROM jobs
     JOIN users ON users.id = jobs.employer_id
     LEFT JOIN employer_profiles ON employer_profiles.user_id = jobs.employer_id
     WHERE jobs.status = 'open'
     ORDER BY jobs.created_at DESC, jobs.id DESC`
  );
  return jobs;
};

const loadProfile = async (userId) => {
  const [rows] = await pool.query('SELECT skills, location FROM job_seeker_profiles WHERE user_id = ? LIMIT 1', [
    userId
  ]);
  return rows[0] || null;
};

const loadAppliedJobIds = async (userId) => {
  const [rows] = await pool.query('SELECT job_id FROM applications WHERE job_seeker_id = ?', [userId]);
  return new Set(rows.map((row) => row.job_id));
};

// Attach the explainable score to each job and sort best-first (newest first on ties).
const rankJobs = (profile, jobs) =>
  jobs
    .map((job) => ({ job, match: scoreJob(profile, job) }))
    .sort((a, b) => b.match.score - a.match.score || b.job.id - a.job.id);

module.exports = { loadOpenJobs, loadProfile, loadAppliedJobIds, rankJobs };
