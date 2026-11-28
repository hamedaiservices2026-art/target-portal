-- Round 5: users can be deleted (kept for the history, hidden from the list),
-- carry a free position label (positions the admin adds), and a Key Account
-- department can be linked to the Operation department whose target it builds
-- on (MT -> Key Account MT, HoReCa -> Key Account Non Retail).
ALTER TABLE users ADD COLUMN deleted_at TEXT;
ALTER TABLE users ADD COLUMN position TEXT;
ALTER TABLE departments ADD COLUMN ops_dept_id INTEGER REFERENCES departments(id);
