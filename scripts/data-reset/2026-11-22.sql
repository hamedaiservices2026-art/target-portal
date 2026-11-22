-- One-time clean-up asked for on 22 Nov 2026: keep only the data uploaded on
-- that day (Riyadh time, from 2026-11-21T21:00Z) and remove what was uploaded
-- before. Users, departments, the hierarchy and the packs stay as they are.
-- Run once by scripts/deploy-ci.mjs (the marker row in settings stops a
-- second run). A copy of every table it changes is kept in bak_20261122_*.

CREATE TABLE IF NOT EXISTS bak_20261122_data_routes AS SELECT * FROM data_routes;
CREATE TABLE IF NOT EXISTS bak_20261122_data_months AS SELECT * FROM data_months;
CREATE TABLE IF NOT EXISTS bak_20261122_cycles AS SELECT * FROM cycles;
CREATE TABLE IF NOT EXISTS bak_20261122_head_approvals AS SELECT * FROM head_approvals;
CREATE TABLE IF NOT EXISTS bak_20261122_notifications AS SELECT * FROM notifications;
CREATE TABLE IF NOT EXISTS bak_20261122_months AS SELECT * FROM months;
CREATE TABLE IF NOT EXISTS bak_20261122_month_files AS SELECT * FROM month_files;
CREATE TABLE IF NOT EXISTS bak_20261122_month_depts AS SELECT * FROM month_depts;
CREATE TABLE IF NOT EXISTS bak_20261122_month_nodes AS SELECT * FROM month_nodes;
CREATE TABLE IF NOT EXISTS bak_20261122_month_leaves AS SELECT * FROM month_leaves;

-- Route sales / previous targets: kept when that workspace, kind and month were uploaded today.
DELETE FROM data_routes WHERE NOT EXISTS (
  SELECT 1 FROM audit a, json_each(a.detail_json, '$.months') m
   WHERE a.at >= '2026-11-21T21:00:00.000Z'
     AND a.action = 'data.' || data_routes.kind || '.upload'
     AND json_extract(a.detail_json, '$.ws') = data_routes.ws
     AND m.value = data_routes.month);

-- New targets, AOP, full-year and department targets: by their upload time.
DELETE FROM data_months WHERE uploaded_at < '2026-11-21T21:00:00.000Z';

-- Target cycles last changed before today, and what hangs on them.
DELETE FROM cycles WHERE updated_at < '2026-11-21T21:00:00.000Z';
DELETE FROM head_approvals WHERE period NOT IN (SELECT period FROM cycles);
DELETE FROM notifications WHERE at < '2026-11-21T21:00:00.000Z';

-- Distribution months started before today.
DELETE FROM month_leaves WHERE month_id IN (SELECT id FROM months WHERE created_at < '2026-11-21T21:00:00.000Z');
DELETE FROM month_nodes WHERE month_id IN (SELECT id FROM months WHERE created_at < '2026-11-21T21:00:00.000Z');
DELETE FROM month_depts WHERE month_id IN (SELECT id FROM months WHERE created_at < '2026-11-21T21:00:00.000Z');
DELETE FROM month_files WHERE month_id IN (SELECT id FROM months WHERE created_at < '2026-11-21T21:00:00.000Z');
DELETE FROM months WHERE created_at < '2026-11-21T21:00:00.000Z';

INSERT OR REPLACE INTO settings(key, value) VALUES ('data_reset_20261122', 'done');
