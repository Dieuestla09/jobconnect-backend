const express = require('express');
const { getScorecard, saveScorecard, jobScorecards } = require('../controllers/scorecardController');
const { protect } = require('../middleware/authMiddleware');
const { authorize } = require('../middleware/roleMiddleware');

const router = express.Router();

// Scorecards are private hiring notes. Job seekers are rejected here with 403 on every route.
router.use(protect, authorize('employer', 'admin'));

// Employers (owner of the job) and admins can read.
router.get('/application/:applicationId', getScorecard);
router.get('/job/:jobId', jobScorecards);

// Only employers write; admins are read-only.
router.put('/application/:applicationId', authorize('employer'), saveScorecard);

module.exports = router;
