-- ============================================================
-- Vitaliage: New Feature Tables
-- Morning Check-ins, Streaks, Achievements, Challenges,
-- Insights, and Wearable Integration Tokens
-- Run this in the Supabase SQL Editor (Database → SQL Editor)
-- ============================================================

-- ============================================================
-- 1. MORNING CHECK-INS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.check_ins (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       TEXT NOT NULL,
  day_key       TEXT NOT NULL,
  energy_level  SMALLINT CHECK (energy_level BETWEEN 1 AND 5),
  mood          SMALLINT CHECK (mood BETWEEN 1 AND 5),
  sleep_quality SMALLINT CHECK (sleep_quality BETWEEN 1 AND 5),
  stress_level  SMALLINT CHECK (stress_level BETWEEN 1 AND 5),
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- One check-in per user per day (upsert support)
ALTER TABLE public.check_ins
  ADD CONSTRAINT check_ins_user_day_unique
  UNIQUE (user_id, day_key);

CREATE INDEX IF NOT EXISTS idx_check_ins_user_date
  ON public.check_ins (user_id, day_key DESC);

-- ============================================================
-- 2. STREAKS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.streaks (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id             TEXT NOT NULL,
  streak_type         TEXT NOT NULL,  -- 'check_in', 'steps', 'sleep', 'hydration'
  current_count       INT DEFAULT 0,
  longest_count       INT DEFAULT 0,
  last_activity_date  TEXT,           -- YYYY-MM-DD
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- One streak record per user per type
ALTER TABLE public.streaks
  ADD CONSTRAINT streaks_user_type_unique
  UNIQUE (user_id, streak_type);

CREATE INDEX IF NOT EXISTS idx_streaks_user
  ON public.streaks (user_id);

-- ============================================================
-- 3. ACHIEVEMENTS (definitions)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.achievements (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  key             TEXT UNIQUE NOT NULL,       -- e.g. 'streak_7_checkin'
  title           TEXT NOT NULL,
  description     TEXT,
  icon_name       TEXT DEFAULT 'star.fill',   -- SF Symbol name
  category        TEXT NOT NULL,              -- 'streak', 'milestone', 'challenge'
  threshold_value INT,
  threshold_type  TEXT,                       -- 'consecutive_days', 'total_count', 'challenge_complete'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 4. USER ACHIEVEMENTS (earned badges)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.user_achievements (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        TEXT NOT NULL,
  achievement_id UUID NOT NULL REFERENCES public.achievements(id),
  earned_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.user_achievements
  ADD CONSTRAINT user_achievements_unique
  UNIQUE (user_id, achievement_id);

CREATE INDEX IF NOT EXISTS idx_user_achievements_user
  ON public.user_achievements (user_id);

-- ============================================================
-- 5. CHALLENGES (weekly challenge definitions)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.challenges (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  category      TEXT NOT NULL,       -- 'steps', 'sleep', 'hydration', 'mindfulness', 'nutrition'
  metric_key    TEXT,                -- 'steps', 'sleep_total_minutes', 'hydration_ml', etc.
  target_value  NUMERIC,
  duration_days INT DEFAULT 7,
  start_date    TEXT,                -- YYYY-MM-DD
  end_date      TEXT,                -- YYYY-MM-DD
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_challenges_active
  ON public.challenges (active, start_date DESC);

-- ============================================================
-- 6. USER CHALLENGES (participation & progress)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.user_challenges (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          TEXT NOT NULL,
  challenge_id     UUID NOT NULL REFERENCES public.challenges(id),
  joined_at        TIMESTAMPTZ DEFAULT NOW(),
  current_progress NUMERIC DEFAULT 0,
  completed        BOOLEAN DEFAULT FALSE,
  completed_at     TIMESTAMPTZ
);

ALTER TABLE public.user_challenges
  ADD CONSTRAINT user_challenges_unique
  UNIQUE (user_id, challenge_id);

CREATE INDEX IF NOT EXISTS idx_user_challenges_user
  ON public.user_challenges (user_id, completed);

-- ============================================================
-- 7. INSIGHTS (personalized generated insights)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.insights (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         TEXT NOT NULL,
  day_key         TEXT NOT NULL,
  insight_type    TEXT NOT NULL,      -- 'trend', 'milestone', 'tip', 'alert'
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  priority        TEXT DEFAULT 'medium',  -- 'high', 'medium', 'low'
  metric_key      TEXT,              -- which metric this relates to
  trend_direction TEXT,              -- 'improving', 'declining', 'stable'
  dismissed       BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insights_user_date
  ON public.insights (user_id, day_key DESC);

CREATE INDEX IF NOT EXISTS idx_insights_undismissed
  ON public.insights (user_id, dismissed) WHERE dismissed = FALSE;

-- ============================================================
-- 8. INTEGRATION TOKENS (wearable OAuth credentials)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.integration_tokens (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           TEXT NOT NULL,
  provider          TEXT NOT NULL,   -- 'garmin', 'oura', 'whoop'
  access_token      TEXT,
  refresh_token     TEXT,
  token_expires_at  TIMESTAMPTZ,
  provider_user_id  TEXT,
  scopes            TEXT,
  active            BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.integration_tokens
  ADD CONSTRAINT integration_tokens_user_provider_unique
  UNIQUE (user_id, provider);

CREATE INDEX IF NOT EXISTS idx_integration_tokens_user
  ON public.integration_tokens (user_id, active);

-- ============================================================
-- 9. SEED: Default Achievement Definitions
-- ============================================================
INSERT INTO public.achievements (key, title, description, icon_name, category, threshold_value, threshold_type) VALUES
  -- Check-in streaks
  ('streak_3_checkin',   'Getting Started',     'Complete 3 consecutive daily check-ins',         'flame.fill',           'streak', 3,   'consecutive_days'),
  ('streak_7_checkin',   'Week Warrior',         'Complete 7 consecutive daily check-ins',         'flame.fill',           'streak', 7,   'consecutive_days'),
  ('streak_14_checkin',  'Two Week Titan',       'Complete 14 consecutive daily check-ins',        'flame.fill',           'streak', 14,  'consecutive_days'),
  ('streak_30_checkin',  'Monthly Master',       'Complete 30 consecutive daily check-ins',        'crown.fill',           'streak', 30,  'consecutive_days'),
  -- Steps milestones
  ('streak_7_steps',     'Step It Up',           'Hit your step goal 7 days in a row',            'figure.walk',          'streak', 7,   'consecutive_days'),
  ('streak_30_steps',    'Walking Wonder',       'Hit your step goal 30 days in a row',           'figure.walk.circle',   'streak', 30,  'consecutive_days'),
  -- Sleep milestones
  ('streak_7_sleep',     'Sleep Champion',       'Meet your sleep goal 7 nights in a row',        'moon.fill',            'streak', 7,   'consecutive_days'),
  ('streak_30_sleep',    'Dream Achiever',       'Meet your sleep goal 30 nights in a row',       'moon.stars.fill',      'streak', 30,  'consecutive_days'),
  -- Challenge achievements
  ('first_challenge',    'Challenge Accepted',   'Complete your first weekly challenge',           'trophy.fill',          'challenge', 1, 'challenge_complete'),
  ('five_challenges',    'Challenge Champion',   'Complete 5 weekly challenges',                   'medal.fill',           'challenge', 5, 'challenge_complete'),
  -- Milestones
  ('first_checkin',      'Hello Vitaliage!',     'Complete your first morning check-in',           'hand.wave.fill',       'milestone', 1, 'total_count'),
  ('hundred_checkins',   'Century Club',         'Complete 100 total check-ins',                   'star.circle.fill',     'milestone', 100, 'total_count')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 10. SEED: Initial Weekly Challenges
-- ============================================================
INSERT INTO public.challenges (title, description, category, metric_key, target_value, duration_days, start_date, end_date, active) VALUES
  ('10K Steps Daily',     'Walk at least 10,000 steps every day this week',       'steps',       'steps',               10000,  7, '2026-03-01', '2026-03-07', TRUE),
  ('Hydration Hero',      'Drink at least 2 liters of water every day',           'hydration',   'hydration_ml',        2000,   7, '2026-03-01', '2026-03-07', TRUE),
  ('Sleep Well',          'Get at least 7 hours of sleep every night',            'sleep',       'sleep_total_minutes', 420,    7, '2026-03-01', '2026-03-07', TRUE),
  ('Mindful Minutes',     'Complete a morning check-in every day this week',      'mindfulness', NULL,                  7,      7, '2026-03-01', '2026-03-07', TRUE)
ON CONFLICT DO NOTHING;
