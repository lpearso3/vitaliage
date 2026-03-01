-- ============================================================
-- Vitaliage: Indexes + Unique Constraint for Beta
-- Run this in the Supabase SQL Editor (Database → SQL Editor)
-- ALREADY EXECUTED on 2026-03-01 — kept for reference.
-- ============================================================

-- 0. Add day_key column (needed for upsert dedup)
ALTER TABLE public.daily_snapshots
  ADD COLUMN IF NOT EXISTS day_key TEXT;

-- 0b. Backfill day_key from snapshot_date for any existing rows
UPDATE public.daily_snapshots
  SET day_key = TO_CHAR(snapshot_date, 'YYYY-MM-DD')
  WHERE day_key IS NULL AND snapshot_date IS NOT NULL;

-- 1. Unique constraint on daily_snapshots (enables upsert dedup)
--    One snapshot per user per day. The server uses .upsert() with
--    onConflict: "user_id,day_key" so retries update instead of duplicating.
ALTER TABLE public.daily_snapshots
  ADD CONSTRAINT daily_snapshots_user_day_unique
  UNIQUE (user_id, day_key);

-- 2. Composite index on daily_snapshots for bundle queries
--    buildResolvedBundle fetches by (user_id, snapshot_date DESC) with a window.
CREATE INDEX IF NOT EXISTS idx_daily_snapshots_user_date
  ON public.daily_snapshots (user_id, snapshot_date DESC);

-- 3. Composite indexes on office measurement tables
--    Each table is queried by (user_id, measured_at DESC) during bundle builds.
CREATE INDEX IF NOT EXISTS idx_office_measurements_user_date
  ON public.office_measurements (user_id, measured_at DESC);

CREATE INDEX IF NOT EXISTS idx_conneqt_assessments_user_date
  ON public.conneqt_assessments (user_id, measured_at DESC);

CREATE INDEX IF NOT EXISTS idx_tanita_assessments_user_date
  ON public.tanita_assessments (user_id, measured_at DESC);

CREATE INDEX IF NOT EXISTS idx_grip_strength_user_date
  ON public.grip_strength_assessments (user_id, measured_at DESC);

CREATE INDEX IF NOT EXISTS idx_rmr_assessments_user_date
  ON public.rmr_assessments (user_id, measured_at DESC);

-- 4. Index on devices for push-latest query
CREATE INDEX IF NOT EXISTS idx_devices_active_lastseen
  ON public.devices (active, last_seen DESC);
