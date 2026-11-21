-- Login throttling (Ruling R4): one row per failed login attempt. Rows are
-- keyed by the lower-cased username as typed, whether or not the user exists,
-- so unknown usernames are throttled exactly like real ones. Rows older than
-- the 15-minute window are pruned on the next failed attempt.
CREATE TABLE login_failures (
  username TEXT NOT NULL,
  at       TEXT NOT NULL   -- ISO-8601 UTC
);
CREATE INDEX idx_login_failures ON login_failures(username, at);
