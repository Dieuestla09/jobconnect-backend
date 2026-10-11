const express = require('express');
const {
  listAlerts,
  createAlert,
  updateAlert,
  setAlertStatus,
  deleteAlert,
  alertMatches
} = require('../controllers/alertController');
const { jobMatch, recommendations } = require('../controllers/matchController');
const { protect } = require('../middleware/authMiddleware');
const { authorize } = require('../middleware/roleMiddleware');

const router = express.Router();

// Alerts and match scores belong to job seekers only.
router.use(protect, authorize('job_seeker'));

router.get('/', listAlerts);
router.post('/', createAlert);
router.put('/:id', updateAlert);
router.patch('/:id/status', setAlertStatus);
router.delete('/:id', deleteAlert);
router.get('/:id/matches', alertMatches);

// Match scoring for the logged-in seeker. Mounted here so the seeker-only guard above applies.
// "/match/..." cannot clash with "/:id" routes because those have a numeric second segment.
router.get('/match/recommendations', recommendations);
router.get('/match/jobs/:jobId', jobMatch);

module.exports = router;
