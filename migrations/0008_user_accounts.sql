-- Admin › Users (v16 layout): the first password the admin hands out is kept
-- until the person chooses their own (then it is cleared), and the time of the
-- last sign-in is shown.
ALTER TABLE users ADD COLUMN first_pw TEXT;
ALTER TABLE users ADD COLUMN last_login TEXT;
