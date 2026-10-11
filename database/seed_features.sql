-- Sample data for the three new features. Re-runnable: it deletes and re-inserts only
-- the rows it owns (alerts 9001-9003, interview 9001, scorecards for job 1's applicants).
-- Requires schema.sql, seed.sql and migrations/001_new_features.sql to have been run.
USE jobconnect;

-- More applicants for job 1 (Frontend Developer) so employers can compare scorecards.
-- INSERT IGNORE + UNIQUE(job_id, job_seeker_id) keeps this idempotent.
INSERT IGNORE INTO applications (job_id, job_seeker_id, cover_letter, cv_file, status) VALUES
(1, 5, 'I am a backend-leaning developer who enjoys building interfaces too.', 'sample-brian-cv.pdf', 'Pending'),
(1, 6, 'I would like to move from customer support into web development.', 'sample-grace-cv.pdf', 'Pending'),
(1, 8, 'I have built landing pages and care about content and accessibility.', 'sample-joan-cv.pdf', 'Shortlisted');

-- Smart Job Alerts for Sarah (id 4) and Brian (id 5).
DELETE FROM job_alerts WHERE id IN (9001, 9002, 9003);
INSERT INTO job_alerts (id, user_id, name, keywords, location, job_type, min_match, is_active) VALUES
(9001, 4, 'Frontend roles in Kampala', 'frontend, react', 'Kampala', NULL, 50, 1),
(9002, 4, 'Any remote work', '', '', 'Remote', 0, 1),
(9003, 5, 'Backend and APIs', 'node, api, backend', '', NULL, 40, 1);

-- Interview scheduler: Sarah (application on job 1) already has a proposed interview.
-- Slot dates are relative to NOW() so they are always in the future when the seed is run.
DELETE FROM interviews WHERE id = 9001;
INSERT INTO interviews (id, application_id, scheduled_by, format, venue, note, status)
SELECT 9001, a.id, 2, 'Video call', 'https://meet.example.com/bluepeak-frontend', 'Bring a short demo of a React project.', 'Proposed'
FROM applications a WHERE a.job_id = 1 AND a.job_seeker_id = 4;
INSERT INTO interview_slots (interview_id, starts_at)
SELECT 9001, DATE_ADD(DATE_FORMAT(NOW(), '%Y-%m-%d 10:00:00'), INTERVAL 3 DAY) FROM interviews WHERE id = 9001
UNION ALL SELECT 9001, DATE_ADD(DATE_FORMAT(NOW(), '%Y-%m-%d 14:00:00'), INTERVAL 4 DAY) FROM interviews WHERE id = 9001
UNION ALL SELECT 9001, DATE_ADD(DATE_FORMAT(NOW(), '%Y-%m-%d 09:30:00'), INTERVAL 5 DAY) FROM interviews WHERE id = 9001;

-- Scorecards written by employer 2 (BluePeak) for three applicants of job 1.
DELETE FROM scorecards WHERE application_id IN (SELECT id FROM applications WHERE job_id = 1);
INSERT INTO scorecards (application_id, reviewer_id, technical, communication, culture_fit, recommendation, notes)
SELECT a.id, 2, s.technical, s.communication, s.culture_fit, s.recommendation, s.notes
FROM applications a
JOIN (
  SELECT 4 AS seeker, 5 AS technical, 4 AS communication, 4 AS culture_fit, 'Strong yes' AS recommendation, 'Strong React portfolio. Clear communicator.' AS notes
  UNION ALL SELECT 5, 3, 4, 3, 'Maybe', 'Solid backend skills, light on CSS.'
  UNION ALL SELECT 8, 2, 4, 5, 'No', 'Great culture fit but not enough frontend experience yet.'
) s ON s.seeker = a.job_seeker_id
WHERE a.job_id = 1;
