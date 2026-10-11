const pool = require('../config/db');
const { scoreJob } = require('../services/matchScore');
const { loadOpenJobs, loadProfile, loadAppliedJobIds, rankJobs } = require('../services/matching');

// Score of the logged-in job seeker against ONE job (shown as the ring on job details).
const jobMatch = async (req, res) => {
  const jobId = Number(req.params.jobId);
  if (!Number.isInteger(jobId) || jobId < 1) {
    return res.status(400).json({ message: 'Invalid job id' });
  }
  try {
    const [jobs] = await pool.query(
      `SELECT jobs.*, employer_profiles.company_name FROM jobs
       LEFT JOIN employer_profiles ON employer_profiles.user_id = jobs.employer_id
       WHERE jobs.id = ? LIMIT 1`,
      [jobId]
    );
    if (!jobs.length) return res.status(404).json({ message: 'Job not found' });
    const profile = await loadProfile(req.user.id);
    res.json({
      profile_has_skills: !!(profile && profile.skills && profile.skills.trim()),
      match: scoreJob(profile, jobs[0])
    });
  } catch (error) {
    res.status(500).json({ message: 'Could not compute match', error: error.message });
  }
};

// Open jobs the seeker has not applied to yet, best profile match first.
const recommendations = async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);
  try {
    const [profile, openJobs, applied] = await Promise.all([
      loadProfile(req.user.id),
      loadOpenJobs(),
      loadAppliedJobIds(req.user.id)
    ]);
    const ranked = rankJobs(
      profile,
      openJobs.filter((job) => !applied.has(job.id))
    ).filter((item) => item.match.score > 0);
    res.json({
      profile_has_skills: !!(profile && profile.skills && profile.skills.trim()),
      recommendations: ranked.slice(0, limit).map(({ job, match }) => ({ job, match }))
    });
  } catch (error) {
    res.status(500).json({ message: 'Could not load recommendations', error: error.message });
  }
};

module.exports = { jobMatch, recommendations };
