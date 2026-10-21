-- "My tasks" lists the month nodes a user manages across all months; without
-- this index every call scans month_nodes (rows read count against D1's daily cap).
CREATE INDEX idx_month_nodes_manager ON month_nodes(manager_user_id);
