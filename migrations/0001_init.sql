-- Target Management Portal: initial schema.
-- Timestamps are ISO-8601 text (UTC). *_json columns hold JSON text.
-- D1 enforces foreign keys. Month tables are history snapshots: their
-- node_id / leaf_id / manager_user_id columns deliberately carry NO foreign key
-- to the live tree or users, so editing the live tree never rewrites or blocks
-- a past month.

CREATE TABLE users (
  id        INTEGER PRIMARY KEY,
  username  TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  email     TEXT,
  pw_hash   TEXT NOT NULL,
  pw_salt   TEXT NOT NULL,
  role      TEXT NOT NULL CHECK (role IN ('admin', 'manager')),
  lang      TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en', 'ar')),
  active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE departments (
  id   INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE packs (
  code   TEXT PRIMARY KEY,
  grp    TEXT NOT NULL CHECK (grp IN ('CSD', 'Water', 'LRB-Others')),
  active INTEGER NOT NULL DEFAULT 1,
  sort   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings(key, value) VALUES ('cap_pct', '5');

-- Live tree (edited by the admin; copied into each month when it opens).
CREATE TABLE nodes (
  id              INTEGER PRIMARY KEY,
  dept_id         INTEGER NOT NULL REFERENCES departments(id),
  parent_id       INTEGER REFERENCES nodes(id),
  name            TEXT NOT NULL,
  manager_user_id INTEGER REFERENCES users(id),
  UNIQUE (dept_id, name)
);
CREATE INDEX idx_nodes_parent ON nodes(parent_id);

CREATE TABLE leaves (
  id              INTEGER PRIMARY KEY,
  dept_id         INTEGER NOT NULL REFERENCES departments(id),
  delivery_system TEXT NOT NULL,
  route_code      TEXT NOT NULL,
  node_id         INTEGER NOT NULL REFERENCES nodes(id),
  label           TEXT NOT NULL,
  UNIQUE (delivery_system, route_code)
);
CREATE INDEX idx_leaves_node ON leaves(node_id);

CREATE TABLE months (
  id         INTEGER PRIMARY KEY,
  period     TEXT NOT NULL UNIQUE,   -- 'YYYY-MM'
  deadline   TEXT,
  packs_json TEXT NOT NULL,          -- pack snapshot: [{code,grp,sort}]
  created_at TEXT NOT NULL
);

CREATE TABLE month_files (
  id          INTEGER PRIMARY KEY,
  month_id    INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
  dept_id     INTEGER NOT NULL REFERENCES departments(id),
  name        TEXT NOT NULL,
  sheet1_json TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL
);
CREATE INDEX idx_month_files_month ON month_files(month_id, dept_id);

CREATE TABLE month_depts (
  month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
  dept_id  INTEGER NOT NULL REFERENCES departments(id),
  state    TEXT NOT NULL CHECK (state IN ('loading', 'running', 'complete')),
  PRIMARY KEY (month_id, dept_id)
) WITHOUT ROWID;

-- Per-month copy of the tree plus workflow state.
CREATE TABLE month_nodes (
  month_id        INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
  node_id         INTEGER NOT NULL,
  dept_id         INTEGER NOT NULL REFERENCES departments(id),
  parent_id       INTEGER,
  name            TEXT NOT NULL,
  manager_user_id INTEGER,
  status          TEXT NOT NULL,
  held_status     TEXT,
  baseline_json   TEXT,
  draft_json      TEXT,
  version         INTEGER NOT NULL DEFAULT 0,
  opened_at       TEXT,
  submitted_at    TEXT,
  PRIMARY KEY (month_id, node_id)
) WITHOUT ROWID;
CREATE INDEX idx_month_nodes_parent ON month_nodes(month_id, parent_id);

-- Packed grid: one row per leaf, all pack values in values_json.
CREATE TABLE month_leaves (
  month_id        INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
  leaf_id         INTEGER NOT NULL,
  node_id         INTEGER NOT NULL,
  dept_id         INTEGER NOT NULL REFERENCES departments(id),
  file_id         INTEGER NOT NULL REFERENCES month_files(id),
  delivery_system TEXT NOT NULL,
  route_code      TEXT NOT NULL,
  salesman_id     TEXT,
  values_json     TEXT NOT NULL,
  PRIMARY KEY (month_id, leaf_id)
) WITHOUT ROWID;
CREATE INDEX idx_month_leaves_node ON month_leaves(month_id, node_id);

CREATE TABLE audit (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id),  -- NULL for system actions (cron)
  action      TEXT NOT NULL,
  month_id    INTEGER,
  node_id     INTEGER,
  detail_json TEXT
);
CREATE INDEX idx_audit_month ON audit(month_id, at);

CREATE TABLE email_log (
  id      INTEGER PRIMARY KEY,
  at      TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  result  TEXT NOT NULL
);
