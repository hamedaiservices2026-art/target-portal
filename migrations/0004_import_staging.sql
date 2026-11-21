-- Bulk user import (Task E): PBKDF2 costs ~5 ms CPU, so only one password is
-- hashed (or checked) per request. Each result is staged here, keyed by the
-- browser's import id, until the one atomic Apply copies the hashes into
-- `users` and deletes the rows. Only hashes are stored, never a password.
-- pw_hash NULL = "the file's password is already the user's password".
-- Rows older than an hour are pruned by the next password step.
CREATE TABLE import_passwords (
  import_id  TEXT NOT NULL,
  username   TEXT NOT NULL,
  actor_id   INTEGER NOT NULL,
  pw_hash    TEXT,
  pw_salt    TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (import_id, username)
) WITHOUT ROWID;
CREATE INDEX idx_import_passwords_at ON import_passwords(created_at);
