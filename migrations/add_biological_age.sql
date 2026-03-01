-- ============================================================
-- Vitaliage: Biological Age History Table
-- Stores computed biological age results over time
-- ============================================================

CREATE TABLE IF NOT EXISTS public.biological_age_history (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id               TEXT NOT NULL,
  computed_at           TIMESTAMPTZ DEFAULT NOW(),

  -- Computed values
  chronological_age     NUMERIC,
  biological_age        NUMERIC,
  age_delta             NUMERIC,                        -- biological_age - chronological_age
  confidence            NUMERIC CHECK (confidence BETWEEN 0 AND 100),  -- Confidence score (0-100)

  -- Detailed breakdown
  breakdown             JSONB,                          -- Array of biomarker components with z-scores, offsets, weights

  -- Input data snapshot
  input_data            JSONB,                          -- { wearableMetrics, clinicLabs, functionalAssessments }

  -- Metadata
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_bio_age_user
  ON public.biological_age_history (user_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_bio_age_computed_at
  ON public.biological_age_history (computed_at DESC);

-- Allow querying by user + date range
CREATE INDEX IF NOT EXISTS idx_bio_age_user_date_range
  ON public.biological_age_history (user_id, computed_at);

-- Optional: Enable RLS if using Supabase Auth (not required for current setup)
-- ALTER TABLE public.biological_age_history ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Users can view their own biological age history"
--   ON public.biological_age_history
--   FOR SELECT
--   USING (auth.uid()::text = user_id);
