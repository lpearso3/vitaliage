-- ============================================================
-- Vitaliage: Supplement Interaction Tracking
-- Stores AI-generated interaction warnings between supplements
-- Run this in the Supabase SQL Editor (Database → SQL Editor)
-- ============================================================

-- ============================================================
-- SUPPLEMENT INTERACTIONS TABLE
-- Caches interaction warnings from AI analysis
-- ============================================================
CREATE TABLE IF NOT EXISTS public.supplement_interactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           TEXT NOT NULL,
  supplement_ids    UUID[] NOT NULL,                        -- array of supplement_protocol UUIDs involved
  severity          TEXT NOT NULL DEFAULT 'info',          -- 'info', 'caution', 'warning'
  summary           TEXT NOT NULL,                          -- brief interaction description
  details           TEXT,                                   -- detailed explanation
  checked_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, supplement_ids)
);

CREATE INDEX IF NOT EXISTS idx_supplement_interactions_user
  ON public.supplement_interactions (user_id);

CREATE INDEX IF NOT EXISTS idx_supplement_interactions_severity
  ON public.supplement_interactions (user_id, severity);

-- ============================================================
-- Lifecycle: Interactions expire after 30 days and should be
-- rechecked via POST /supplements/check-interactions
-- ============================================================
