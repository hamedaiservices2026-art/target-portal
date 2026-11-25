-- The AOP by pack and department (one month per row, {channel: {pack: cases}})
-- is a new kind of month data: the kind check is widened (table rebuilt, data kept).
CREATE TABLE data_months_new (
  ws          TEXT NOT NULL CHECK (ws IN ('ops', 'ka')),
  kind        TEXT NOT NULL CHECK (kind IN ('new_target', 'aop', 'fy_target', 'dept_channel', 'aop_dept')),
  month       TEXT NOT NULL,
  values_json TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (ws, kind, month)
) WITHOUT ROWID;
INSERT INTO data_months_new (ws, kind, month, values_json, uploaded_by, uploaded_at)
  SELECT ws, kind, month, values_json, uploaded_by, uploaded_at FROM data_months;
DROP TABLE data_months;
ALTER TABLE data_months_new RENAME TO data_months;
