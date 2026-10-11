-- Migration 001: Smart Job Alerts, Interview Scheduler, Candidate Scorecards.
--
-- Safe to run many times: every statement uses IF NOT EXISTS and nothing is dropped.
-- It does NOT modify schema.sql or any original table. Run schema.sql + seed.sql first.
--   npm run migrate        (or: mysql -u root -p jobconnect < database/migrations/001_new_features.sql)
USE jobconnect;

-- ---------------------------------------------------------------------------
-- Feature 1: Smart Job Alerts (job seekers save search preferences).
-- Matches are NOT stored; they are computed live from jobs + the seeker profile.
-- The "max 10 alerts per user" rule is enforced by the API.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_alerts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  keywords VARCHAR(200) NOT NULL DEFAULT '',
  location VARCHAR(160) NOT NULL DEFAULT '',
  job_type ENUM('Full-time', 'Part-time', 'Contract', 'Internship', 'Remote') NULL,
  min_match TINYINT UNSIGNED NOT NULL DEFAULT 50,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_alerts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_alerts_min_match CHECK (min_match BETWEEN 0 AND 100),
  INDEX idx_alerts_user (user_id)
);

-- ---------------------------------------------------------------------------
-- Feature 2: Interview Scheduler.
-- One interview row per proposal; 1-3 proposed slots live in interview_slots.
-- active_application_id is NULL once an interview is Declined/Cancelled, so the
-- UNIQUE index allows only ONE Proposed/Confirmed interview per application
-- while keeping the history of earlier ones.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  application_id INT NOT NULL,
  scheduled_by INT NOT NULL,
  format ENUM('Video call', 'Phone', 'On-site') NOT NULL,
  venue VARCHAR(255) NOT NULL,
  note VARCHAR(500) NULL,
  status ENUM('Proposed', 'Confirmed', 'Declined', 'Cancelled') NOT NULL DEFAULT 'Proposed',
  decline_reason VARCHAR(500) NULL,
  active_application_id INT GENERATED ALWAYS AS (
    CASE WHEN status IN ('Proposed', 'Confirmed') THEN application_id ELSE NULL END
  ) STORED,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_interviews_application FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_interviews_employer FOREIGN KEY (scheduled_by) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_interviews_one_active (active_application_id),
  INDEX idx_interviews_application (application_id)
);

CREATE TABLE IF NOT EXISTS interview_slots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  interview_id INT NOT NULL,
  starts_at DATETIME NOT NULL,
  is_selected TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_slots_interview FOREIGN KEY (interview_id) REFERENCES interviews(id) ON DELETE CASCADE,
  UNIQUE KEY uq_slot_per_interview (interview_id, starts_at)
);

-- ---------------------------------------------------------------------------
-- Feature 3: Candidate Scorecards (employer-private).
-- UNIQUE(application_id) gives "one scorecard per application" and lets the API
-- upsert. `overall` is computed by the database, never sent by the client.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scorecards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  application_id INT NOT NULL UNIQUE,
  reviewer_id INT NOT NULL,
  technical TINYINT UNSIGNED NOT NULL,
  communication TINYINT UNSIGNED NOT NULL,
  culture_fit TINYINT UNSIGNED NOT NULL,
  recommendation ENUM('Strong yes', 'Yes', 'Maybe', 'No') NOT NULL,
  notes TEXT NULL,
  overall DECIMAL(3, 2) GENERATED ALWAYS AS (ROUND((technical + communication + culture_fit) / 3, 2)) STORED,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_scorecards_application FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_scorecards_reviewer FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_scorecards_technical CHECK (technical BETWEEN 1 AND 5),
  CONSTRAINT chk_scorecards_communication CHECK (communication BETWEEN 1 AND 5),
  CONSTRAINT chk_scorecards_culture CHECK (culture_fit BETWEEN 1 AND 5),
  CONSTRAINT chk_scorecards_notes CHECK (notes IS NULL OR CHAR_LENGTH(notes) <= 2000)
);
