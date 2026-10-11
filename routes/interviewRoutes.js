const express = require('express');
const {
  proposeInterview,
  listInterviews,
  confirmInterview,
  declineInterview,
  cancelInterview
} = require('../controllers/interviewController');
const { protect } = require('../middleware/authMiddleware');
const { authorize } = require('../middleware/roleMiddleware');

const router = express.Router();

router.use(protect);

// Seekers see their invitations, employers see interviews for their jobs, admins see everything (read-only).
router.get('/', authorize('job_seeker', 'employer', 'admin'), listInterviews);

// Employers propose and cancel. Ownership of the job is checked inside the controller.
router.post('/', authorize('employer'), proposeInterview);
router.post('/:id/cancel', authorize('employer'), cancelInterview);

// Only the invited job seeker can answer.
router.post('/:id/confirm', authorize('job_seeker'), confirmInterview);
router.post('/:id/decline', authorize('job_seeker'), declineInterview);

module.exports = router;
