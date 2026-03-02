-- AI Summaries cache table
-- Stores one Claude-generated summary per user per day to avoid repeated API calls.

CREATE TABLE IF NOT EXISTS ai_summaries (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     text NOT NULL,
  day_key     text NOT NULL,          -- YYYY-MM-DD
  summary_text text NOT NULL,
  model       text DEFAULT 'claude-sonnet-4-5-20250929',
  created_at  timestamptz DEFAULT now(),

  CONSTRAINT ai_summaries_user_day UNIQUE (user_id, day_key)
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_ai_summaries_user_day
  ON ai_summaries (user_id, day_key);
