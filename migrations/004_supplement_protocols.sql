-- ============================================================
-- Vitaliage: Supplement & Medication Tracking
-- Supplements, medications, and adherence tracking tables
-- Run this in the Supabase SQL Editor (Database → SQL Editor)
-- ============================================================

-- ============================================================
-- 1. SUPPLEMENT PROTOCOLS (user's supplements/medications)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.supplement_protocols (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  dosage            TEXT,                              -- "1 capsule", "500mg", "1 tablet"
  unit              TEXT,                              -- "mg", "mcg", "IU", "capsule", "tablet"
  frequency         TEXT DEFAULT 'daily',              -- "daily", "weekly", "as_needed", "twice_daily"
  times_per_day     INT DEFAULT 1,                     -- number of times per day
  scheduled_times   JSONB DEFAULT '["08:00"]',         -- ["08:00", "20:00"] for times throughout day
  instructions      TEXT,                              -- "Take with food", etc.
  category          TEXT DEFAULT 'supplement',         -- "supplement", "medication", "vitamin", "mineral"
  prescribed_by     TEXT,                              -- clinician name
  start_date        DATE,
  end_date          DATE,                              -- NULL = ongoing
  active            BOOLEAN DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplement_protocols_user
  ON public.supplement_protocols (user_id, active DESC);

CREATE INDEX IF NOT EXISTS idx_supplement_protocols_active_dates
  ON public.supplement_protocols (user_id, active, start_date, end_date)
  WHERE active = true;

-- ============================================================
-- 2. SUPPLEMENT LOGS (adherence tracking - when taken)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.supplement_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           TEXT NOT NULL,
  protocol_id       UUID NOT NULL REFERENCES public.supplement_protocols(id) ON DELETE CASCADE,
  taken_at          TIMESTAMPTZ DEFAULT NOW(),
  day_key           TEXT NOT NULL,                     -- YYYY-MM-DD for easy grouping
  scheduled_time    TEXT,                              -- "08:00" time it was scheduled for
  status            TEXT DEFAULT 'taken',              -- "taken", "skipped", "missed"
  notes             TEXT,                              -- "Took with breakfast"
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, protocol_id, day_key, scheduled_time)
);

CREATE INDEX IF NOT EXISTS idx_supplement_logs_user_day
  ON public.supplement_logs (user_id, day_key DESC);

CREATE INDEX IF NOT EXISTS idx_supplement_logs_protocol_day
  ON public.supplement_logs (protocol_id, day_key DESC);

CREATE INDEX IF NOT EXISTS idx_supplement_logs_taken_at
  ON public.supplement_logs (user_id, taken_at DESC);

-- ============================================================
-- TRIGGER: Auto-update supplement_protocols.updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_supplement_protocols_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER supplement_protocols_updated_at
  BEFORE UPDATE ON public.supplement_protocols
  FOR EACH ROW
  EXECUTE FUNCTION public.update_supplement_protocols_timestamp();

-- ============================================================
-- TRIGGER: Auto-update supplement_logs.updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_supplement_logs_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER supplement_logs_updated_at
  BEFORE UPDATE ON public.supplement_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_supplement_logs_timestamp();
