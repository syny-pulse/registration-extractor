-- Registration Extractor schema.
--
-- Read the absences here as deliberate: there is no documents table, no
-- extractions table, and not even a filename column. Nothing in this database
-- can hold an attendee name, a phone number, or a scanned page. A full dump
-- leaks account emails and per-user usage counts, and that is the entire blast
-- radius. The retention guarantee is structural rather than promised.

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  -- Backstop behind the conditional UPDATE in spendCredit(); if that guard is
  -- ever refactored away, the database still refuses to go negative.
  credits       integer NOT NULL DEFAULT 0 CHECK (credits >= 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_count integer NOT NULL,
  status     text NOT NULL CHECK (status IN ('success', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_logs_user_created
  ON usage_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS usage_logs_created
  ON usage_logs (created_at DESC);
