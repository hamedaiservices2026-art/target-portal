-- Handover design (v16 reference): workspaces, Commercial Director role,
-- channels per Head of Department, the Admin data store (8-step start), the
-- monthly target cycle per workspace, Head approval, in-app notifications.

-- Each department is one Head of Department, in the Operations or the Key
-- Accounts workspace.
ALTER TABLE departments ADD COLUMN workspace TEXT NOT NULL DEFAULT 'ops' CHECK (workspace IN ('ops', 'ka'));
ALTER TABLE departments ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;

-- Channels a Head owns (TT DMM, TT Outer, MT, MT SSV, MT Bulk, HoReCa, WS...).
-- Names must match the column names of the department files.
CREATE TABLE dept_channels (
  dept_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  grp     TEXT NOT NULL DEFAULT '',  -- channel group: TT, MT, HoReCa, WS
  sort    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dept_id, channel)
) WITHOUT ROWID;
CREATE UNIQUE INDEX uq_dept_channels_name ON dept_channels(channel);

-- Extra roles on top of users.role: the Commercial Director, per workspace.
CREATE TABLE user_roles (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('cd')),
  workspace TEXT NOT NULL CHECK (workspace IN ('ops', 'ka')),
  PRIMARY KEY (user_id, role, workspace)
) WITHOUT ROWID;

-- First login forces a password change.
ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN employee_id TEXT;

-- Route-level history, packed per route and month: values_json = {pack: cases}.
--   sales:       actual sales (step 5)
--   prev_target: previous route targets (step 6); extra_json = {salesmanId, deliverySystem}
CREATE TABLE data_routes (
  ws         TEXT NOT NULL CHECK (ws IN ('ops', 'ka')),
  kind       TEXT NOT NULL CHECK (kind IN ('sales', 'prev_target')),
  month      TEXT NOT NULL,  -- 'YYYY-MM'
  route_code TEXT NOT NULL,
  extra_json TEXT,
  values_json TEXT NOT NULL,
  PRIMARY KEY (ws, kind, month, route_code)
) WITHOUT ROWID;

-- Month-level data, one row per workspace, kind and month:
--   new_target:   {mode: 'pack'|'dept', byPack: {pack: cases}, byChannel?: {channel: {pack: cases}}}  (step 2)
--   aop:          {pack: {cases, nr}}                                                             (step 3)
--   fy_target:    {pack: cases}                                                                   (step 4)
--   dept_channel: {channel: {pack: cases}}                                                        (step 7)
CREATE TABLE data_months (
  ws          TEXT NOT NULL CHECK (ws IN ('ops', 'ka')),
  kind        TEXT NOT NULL CHECK (kind IN ('new_target', 'aop', 'fy_target', 'dept_channel')),
  month       TEXT NOT NULL,
  values_json TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (ws, kind, month)
) WITHOUT ROWID;

-- One target cycle per workspace and target month.
--   settings_json: {cdStep, deadlines: {head, manager, supervisor}, avgMonths, ntMode}
--   cd_json:       the Commercial Director's work (New Target edits and approval,
--                  department x channel x pack split, column I and J, final split)
--   calc_json:     the applied route calculation {deptId: {routeCode: {pack: cases}}}
CREATE TABLE cycles (
  ws            TEXT NOT NULL CHECK (ws IN ('ops', 'ka')),
  period        TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  cd_status     TEXT NOT NULL DEFAULT 'draft' CHECK (cd_status IN ('draft', 'with_cd', 'submitted', 'returned')),
  cd_comment    TEXT,
  cd_json       TEXT,
  dept_json     TEXT,          -- department target per pack used by the calculator {deptId: {pack: cases}}
  calc_json     TEXT,
  calc_notes    TEXT,
  version       INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (ws, period)
) WITHOUT ROWID;

-- Head of Department approval of the target Admin sent.
CREATE TABLE head_approvals (
  period     TEXT NOT NULL,
  dept_id    INTEGER NOT NULL REFERENCES departments(id),
  status     TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'approved', 'returned')),
  sent_total INTEGER,
  sent_json  TEXT,             -- {category: cases} sent
  sent_at    TEXT,
  decided_at TEXT,
  comment    TEXT,
  PRIMARY KEY (period, dept_id)
) WITHOUT ROWID;

-- In-app notifications at every hand-off.
CREATE TABLE notifications (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  text    TEXT NOT NULL,
  link    TEXT,
  read_at TEXT
);
CREATE INDEX idx_notifications_user ON notifications(user_id, id);

-- Distribution rules: caps per level, rules 2 and 3 on/off, per-person exceptions.
INSERT INTO settings(key, value) VALUES
  ('rules_json', '{"caps":{"head":5,"manager":5,"supervisor":5},"rule2":true,"rule3":true,"exceptions":[]}');
