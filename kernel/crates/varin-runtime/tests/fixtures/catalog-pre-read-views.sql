-- Restore the released pre-read-view layout, not just its format marker.
DROP INDEX events_thread_cursor;
ALTER TABLE events DROP COLUMN thread_id;
ALTER TABLE events DROP COLUMN branch_id;
ALTER TABLE threads DROP COLUMN hidden_kind;
