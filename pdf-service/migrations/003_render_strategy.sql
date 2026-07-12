-- Phase 4/5 review: record WHICH RenderStrategy produced each artifact on the
-- manifest row itself. 001 had no metadata column and the strategy was only in
-- logs, so this is a new column. Nullable (historic rows predate it); grants
-- are table-level so manifest_writer's INSERT permission already covers it —
-- no grant changes needed, append-only property unchanged.

ALTER TABLE manifest_entries
  ADD COLUMN IF NOT EXISTS render_strategy TEXT
  CHECK (render_strategy IN ('SinglePass', 'ChunkedMerge') OR render_strategy IS NULL);
