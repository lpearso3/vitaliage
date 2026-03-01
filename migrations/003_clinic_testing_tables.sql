-- ============================================================
-- Vitaliage: Clinic Testing Day Tables
-- Testing Sessions, Functional Assessments, VO2 Assessments,
-- Lab Results, Care Plans + ALTER existing tables
-- Run this in the Supabase SQL Editor (Database → SQL Editor)
-- ============================================================

-- ============================================================
-- 1. TESTING SESSIONS (groups all tests from one clinic visit)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.testing_sessions (
  id                        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                   TEXT NOT NULL,
  session_date              DATE NOT NULL,
  clinician_id              TEXT,
  session_type              TEXT DEFAULT 'initial',    -- 'initial', 'quarterly_retest', 'followup'
  status                    TEXT DEFAULT 'in_progress', -- 'in_progress', 'completed', 'reviewed'
  notes                     TEXT,

  -- Global Recovery & Longevity Risk Summary (Section 8 of testing packet)
  hr_recovery_best          INT,                        -- Best HR recovery observed (bpm)
  cardio_fitness_category   TEXT,                       -- e.g. 'poor', 'fair', 'good', 'excellent', 'superior'
  strength_power_category   TEXT,
  autonomic_balance_category TEXT,
  frailty_risk              TEXT,                       -- 'low', 'moderate', 'elevated'
  longevity_risk_tier       INT CHECK (longevity_risk_tier BETWEEN 1 AND 5),
  personalized_plan_summary TEXT,

  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_testing_sessions_user
  ON public.testing_sessions (user_id, session_date DESC);

-- ============================================================
-- 2. FUNCTIONAL ASSESSMENTS (Sit-to-Stand, Gait Speed, 6MWT)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.functional_assessments (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id            UUID REFERENCES public.testing_sessions(id),
  user_id               TEXT NOT NULL,
  test_type             TEXT NOT NULL,                  -- 'sit_to_stand', 'gait_speed', 'six_min_walk'
  measured_at           TIMESTAMPTZ DEFAULT NOW(),
  day_key               TEXT,

  -- 5x Sit-to-Stand (Section 4)
  sts_time_seconds      NUMERIC,
  sts_hands_used        BOOLEAN,
  sts_balance_loss      BOOLEAN,
  sts_immediate_hr      INT,
  sts_chair_height_cm   NUMERIC,

  -- 4-Meter Gait Speed (Section 5)
  gait_time_seconds     NUMERIC,
  gait_speed_ms         NUMERIC,
  gait_assistive_device BOOLEAN,
  gait_interpretation   TEXT,                          -- 'slow' (<0.8), 'moderate' (0.8-1.0), 'normal' (>1.0)

  -- 6-Minute Walk Test (Section 6)
  walk_distance_meters    NUMERIC,
  walk_percent_predicted  NUMERIC,
  walk_peak_hr            INT,
  walk_recovery_hr_1min   INT,
  walk_post_rpe           INT CHECK (walk_post_rpe BETWEEN 6 AND 20),
  walk_symptoms           TEXT,

  -- Common
  percentile_age_sex    TEXT,
  interpretation        TEXT,
  notes                 TEXT,
  raw_json              JSONB,

  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_functional_user_date
  ON public.functional_assessments (user_id, measured_at DESC);

CREATE INDEX IF NOT EXISTS idx_functional_session
  ON public.functional_assessments (session_id);

-- ============================================================
-- 3. VO2 ASSESSMENTS (Submaximal VO2 Bike Test - Section 7)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.vo2_assessments (
  id                           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id                   UUID REFERENCES public.testing_sessions(id),
  user_id                      TEXT NOT NULL,
  measured_at                  TIMESTAMPTZ DEFAULT NOW(),
  day_key                      TEXT,

  protocol                     TEXT DEFAULT 'precor_watt',  -- 'precor_watt', 'astrand', 'ymca'
  final_workload_watts         NUMERIC,
  minute_2_hr                  INT,
  minute_3_hr                  INT,
  kgm_per_min                  NUMERIC,                    -- Watts × 6.12
  estimated_vo2_ml_kg_min      NUMERIC,
  age_adjusted_interpretation  TEXT,                        -- 'poor', 'fair', 'good', 'excellent', 'superior'
  hr_recovery_1min             INT,
  hr_recovery_best             INT,
  cardio_fitness_category      TEXT,

  notes                        TEXT,
  raw_json                     JSONB,

  created_at                   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vo2_user_date
  ON public.vo2_assessments (user_id, measured_at DESC);

CREATE INDEX IF NOT EXISTS idx_vo2_session
  ON public.vo2_assessments (session_id);

-- ============================================================
-- 4. LAB RESULTS (Blood Work & Biomarkers)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.lab_results (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id            UUID REFERENCES public.testing_sessions(id),
  user_id               TEXT NOT NULL,
  collected_at          TIMESTAMPTZ DEFAULT NOW(),
  day_key               TEXT,
  lab_name              TEXT,                          -- 'Quest', 'LabCorp', 'in-house'

  -- Metabolic
  hba1c_pct             NUMERIC,
  fasting_glucose_mg_dl NUMERIC,
  insulin_uiu_ml        NUMERIC,
  homa_ir               NUMERIC,

  -- Lipids
  total_cholesterol     NUMERIC,
  ldl_cholesterol       NUMERIC,
  hdl_cholesterol       NUMERIC,
  triglycerides         NUMERIC,
  apob_mg_dl            NUMERIC,                      -- Key longevity marker
  lpa_nmol_l            NUMERIC,                      -- Lipoprotein(a)

  -- Inflammation
  hs_crp_mg_l           NUMERIC,
  homocysteine_umol_l   NUMERIC,

  -- Hormones
  testosterone_ng_dl    NUMERIC,
  free_testosterone     NUMERIC,
  dhea_s                NUMERIC,
  cortisol_am           NUMERIC,
  tsh                   NUMERIC,
  vitamin_d_ng_ml       NUMERIC,

  -- Flexible for any additional labs
  additional_results    JSONB,
  report_pdf_url        TEXT,
  notes                 TEXT,
  raw_json              JSONB,

  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lab_results_user_date
  ON public.lab_results (user_id, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_lab_results_session
  ON public.lab_results (session_id);

-- ============================================================
-- 5. CARE PLANS (Workout, Nutrition, Lifestyle Plans)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.care_plans (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id      UUID REFERENCES public.testing_sessions(id),
  user_id         TEXT NOT NULL,
  plan_type       TEXT NOT NULL,                       -- 'workout', 'nutrition', 'lifestyle', 'combined'
  title           TEXT,
  summary         TEXT,
  plan_body       JSONB,                               -- Structured plan content
  goals           JSONB,                               -- Array of measurable goals [{metric, baseline, target, unit}]
  start_date      DATE,
  end_date        DATE,
  status          TEXT DEFAULT 'active',               -- 'active', 'completed', 'superseded'
  adherence_pct   NUMERIC,
  pdf_url         TEXT,
  created_by      TEXT,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_care_plans_user
  ON public.care_plans (user_id, status);

CREATE INDEX IF NOT EXISTS idx_care_plans_session
  ON public.care_plans (session_id);

-- ============================================================
-- 6. ALTER EXISTING TABLES: Add session_id + missing fields
-- ============================================================

-- 6a. office_measurements
ALTER TABLE public.office_measurements
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES public.testing_sessions(id),
  ADD COLUMN IF NOT EXISTS spo2_pct NUMERIC,
  ADD COLUMN IF NOT EXISTS rpe_baseline INT,
  ADD COLUMN IF NOT EXISTS resting_hr INT,
  ADD COLUMN IF NOT EXISTS height_cm NUMERIC;

-- 6b. conneqt_assessments: session linkage + HRV baseline + classifications
ALTER TABLE public.conneqt_assessments
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES public.testing_sessions(id),
  ADD COLUMN IF NOT EXISTS recording_duration_min NUMERIC,
  ADD COLUMN IF NOT EXISTS hrv_ms NUMERIC,
  ADD COLUMN IF NOT EXISTS rmssd NUMERIC,
  ADD COLUMN IF NOT EXISTS stress_index NUMERIC,
  ADD COLUMN IF NOT EXISTS signal_quality TEXT,
  ADD COLUMN IF NOT EXISTS central_bp_classification TEXT,
  ADD COLUMN IF NOT EXISTS central_pp_classification TEXT,
  ADD COLUMN IF NOT EXISTS ppa_classification TEXT,
  ADD COLUMN IF NOT EXISTS brachial_bp_classification TEXT,
  ADD COLUMN IF NOT EXISTS aug_pressure_classification TEXT,
  ADD COLUMN IF NOT EXISTS aug_index_classification TEXT,
  ADD COLUMN IF NOT EXISTS sevr_classification TEXT,
  ADD COLUMN IF NOT EXISTS cv_risk_zone TEXT,
  ADD COLUMN IF NOT EXISTS risk_factors_high JSONB,
  ADD COLUMN IF NOT EXISTS risk_factors_intermediate JSONB,
  ADD COLUMN IF NOT EXISTS report_date DATE;

-- 6c. grip_strength_assessments
ALTER TABLE public.grip_strength_assessments
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES public.testing_sessions(id),
  ADD COLUMN IF NOT EXISTS dominant_hand TEXT,
  ADD COLUMN IF NOT EXISTS grip_to_bw_ratio NUMERIC,
  ADD COLUMN IF NOT EXISTS percentile_age_sex TEXT;

-- 6d. tanita_assessments → extend for Charder MA601
ALTER TABLE public.tanita_assessments
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES public.testing_sessions(id),
  ADD COLUMN IF NOT EXISTS icw_lbs NUMERIC,
  ADD COLUMN IF NOT EXISTS ecw_lbs NUMERIC,
  ADD COLUMN IF NOT EXISTS protein_lbs NUMERIC,
  ADD COLUMN IF NOT EXISTS mineral_lbs NUMERIC,
  ADD COLUMN IF NOT EXISTS slm_lbs NUMERIC,
  ADD COLUMN IF NOT EXISTS smm_lbs NUMERIC,
  ADD COLUMN IF NOT EXISTS phase_angle_deg NUMERIC,
  ADD COLUMN IF NOT EXISTS ffm_index NUMERIC,
  ADD COLUMN IF NOT EXISTS smi NUMERIC,
  ADD COLUMN IF NOT EXISTS asmi NUMERIC,
  ADD COLUMN IF NOT EXISTS bmi NUMERIC,
  ADD COLUMN IF NOT EXISTS vfa_rating NUMERIC,
  ADD COLUMN IF NOT EXISTS total_energy_expenditure NUMERIC,
  ADD COLUMN IF NOT EXISTS health_score NUMERIC,
  ADD COLUMN IF NOT EXISTS muscle_quality_score NUMERIC,
  ADD COLUMN IF NOT EXISTS target_weight_lbs NUMERIC,
  ADD COLUMN IF NOT EXISTS weight_control_lbs NUMERIC,
  ADD COLUMN IF NOT EXISTS fat_control_lbs NUMERIC,
  ADD COLUMN IF NOT EXISTS muscle_control_lbs NUMERIC,
  ADD COLUMN IF NOT EXISTS segmental_lean JSONB,
  ADD COLUMN IF NOT EXISTS segmental_fat JSONB,
  ADD COLUMN IF NOT EXISTS body_balance JSONB,
  ADD COLUMN IF NOT EXISTS impedance_data JSONB,
  ADD COLUMN IF NOT EXISTS grip_right_n NUMERIC,
  ADD COLUMN IF NOT EXISTS grip_left_n NUMERIC,
  ADD COLUMN IF NOT EXISTS grip_right_lbf NUMERIC,
  ADD COLUMN IF NOT EXISTS grip_left_lbf NUMERIC;

-- 6e. rmr_assessments
ALTER TABLE public.rmr_assessments
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES public.testing_sessions(id);
