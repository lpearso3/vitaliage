/**
 * Biological Age Calculation Service
 *
 * Combines wearable metrics with clinic lab values to estimate biological age.
 * Uses established aging clock concepts (PhenoAge, GrimAge) adapted for available biomarkers.
 *
 * Algorithm:
 * - Each biomarker gets a "biological age offset" based on how it compares to
 *   age/sex-normalized population averages
 * - Positive offset = aging faster, negative = aging slower
 * - Offsets are weighted by evidence strength and combined
 * - Final biological age = chronological age + weighted sum of offsets
 */

/**
 * Population reference values for age/sex-normalized comparisons.
 * Based on epidemiological data and longevity studies.
 * Format: { p5, p50, p95 } are 5th, 50th (median), 95th percentiles by age/sex
 */
const REFERENCE_VALUES = {
  // VO2 Max (ml/kg/min) - Strong predictor of all-cause mortality
  vo2Max: {
    male: {
      30: { p5: 35, p50: 42, p95: 52 },
      40: { p5: 33, p50: 40, p95: 50 },
      50: { p5: 29, p50: 36, p95: 45 },
      60: { p5: 24, p50: 31, p95: 40 },
      70: { p5: 20, p50: 27, p95: 36 },
    },
    female: {
      30: { p5: 27, p50: 33, p95: 41 },
      40: { p5: 25, p50: 31, p95: 39 },
      50: { p5: 21, p50: 27, p95: 35 },
      60: { p5: 18, p50: 24, p95: 32 },
      70: { p5: 15, p50: 21, p95: 29 },
    },
  },

  // Heart Rate Variability (ms) - High HRV indicates better autonomic health
  hrv: {
    male: {
      30: { p5: 30, p50: 70, p95: 120 },
      40: { p5: 28, p50: 65, p95: 110 },
      50: { p5: 25, p50: 60, p95: 100 },
      60: { p5: 20, p50: 50, p95: 85 },
      70: { p5: 15, p50: 40, p95: 70 },
    },
    female: {
      30: { p5: 25, p50: 60, p95: 100 },
      40: { p5: 23, p50: 55, p95: 90 },
      50: { p5: 20, p50: 50, p95: 80 },
      60: { p5: 18, p50: 45, p95: 75 },
      70: { p5: 15, p50: 40, p95: 70 },
    },
  },

  // Resting Heart Rate (bpm) - Lower is better
  restingHR: {
    male: {
      30: { p5: 50, p50: 62, p95: 76 },
      40: { p5: 52, p50: 64, p95: 78 },
      50: { p5: 54, p50: 66, p95: 80 },
      60: { p5: 56, p50: 68, p95: 82 },
      70: { p5: 58, p50: 70, p95: 84 },
    },
    female: {
      30: { p5: 52, p50: 65, p95: 80 },
      40: { p5: 54, p50: 67, p95: 82 },
      50: { p5: 56, p50: 69, p95: 84 },
      60: { p5: 58, p50: 71, p95: 86 },
      70: { p5: 60, p50: 73, p95: 88 },
    },
  },

  // hs-CRP (mg/L) - Inflammation marker
  hsCRP: {
    all: {
      all: { p5: 0.2, p50: 1.5, p95: 5.0 },
    },
  },

  // Grip Strength (kg) - Strong mortality predictor
  gripStrength: {
    male: {
      30: { p5: 35, p50: 48, p95: 61 },
      40: { p5: 34, p50: 47, p95: 60 },
      50: { p5: 32, p50: 44, p95: 56 },
      60: { p5: 28, p50: 40, p95: 52 },
      70: { p5: 24, p50: 35, p95: 46 },
    },
    female: {
      30: { p5: 18, p50: 26, p95: 35 },
      40: { p5: 17, p50: 25, p95: 34 },
      50: { p5: 16, p50: 24, p95: 33 },
      60: { p5: 14, p50: 21, p95: 30 },
      70: { p5: 12, p50: 18, p95: 26 },
    },
  },

  // Total Cholesterol (mg/dL)
  totalCholesterol: {
    all: {
      all: { p5: 150, p50: 200, p95: 250 },
    },
  },

  // HDL Cholesterol (mg/dL) - Higher is better
  hdlCholesterol: {
    all: {
      all: { p5: 30, p50: 50, p95: 75 },
    },
  },

  // LDL Cholesterol (mg/dL) - Lower is better
  ldlCholesterol: {
    all: {
      all: { p5: 50, p50: 120, p95: 180 },
    },
  },

  // Triglycerides (mg/dL)
  triglycerides: {
    all: {
      all: { p5: 50, p50: 120, p95: 250 },
    },
  },

  // Fasting Glucose (mg/dL)
  fastingGlucose: {
    all: {
      all: { p5: 85, p50: 100, p95: 130 },
    },
  },

  // BMI
  bmi: {
    all: {
      all: { p5: 19, p50: 25, p95: 32 },
    },
  },

  // Body Fat Percentage (%)
  bodyFatPercent: {
    male: {
      all: { p5: 15, p50: 25, p95: 40 },
    },
    female: {
      all: { p5: 22, p50: 32, p95: 45 },
    },
  },

  // Gait Speed (m/s) - Functional mobility predictor
  gaitSpeed: {
    male: {
      65: { p5: 0.7, p50: 1.1, p95: 1.5 },
      75: { p5: 0.6, p50: 1.0, p95: 1.4 },
    },
    female: {
      65: { p5: 0.6, p50: 1.0, p95: 1.4 },
      75: { p5: 0.5, p50: 0.9, p95: 1.3 },
    },
  },

  // Sleep Duration (hours) - Optimal is ~7-8 hours
  sleepDuration: {
    all: {
      all: { p5: 5, p50: 7.5, p95: 9 },
    },
  },
};

/**
 * Get reference values for a given age/sex/metric.
 * Interpolates between age brackets if exact age not found.
 */
function getReference(metric, age, sex, value) {
  const refs = REFERENCE_VALUES[metric];
  if (!refs) return null;

  const sexRefs = refs[sex] || refs.all;
  if (!sexRefs) return null;

  const ages = Object.keys(sexRefs)
    .map(Number)
    .filter(a => a !== 'all')
    .sort((a, b) => a - b);

  // Find bracket
  let ageKey = 'all';
  if (ages.length > 0) {
    if (age <= ages[0]) {
      ageKey = ages[0];
    } else if (age >= ages[ages.length - 1]) {
      ageKey = ages[ages.length - 1];
    } else {
      // Interpolate between two ages
      for (let i = 0; i < ages.length - 1; i++) {
        if (age >= ages[i] && age <= ages[i + 1]) {
          const lower = sexRefs[ages[i]];
          const upper = sexRefs[ages[i + 1]];
          const fraction = (age - ages[i]) / (ages[i + 1] - ages[i]);
          return {
            p5: lower.p5 + (upper.p5 - lower.p5) * fraction,
            p50: lower.p50 + (upper.p50 - lower.p50) * fraction,
            p95: lower.p95 + (upper.p95 - lower.p95) * fraction,
          };
        }
      }
    }
  }

  return sexRefs[ageKey] || null;
}

/**
 * Convert a percentile to a z-score (standard deviations from median).
 * Negative z = below median (aging slower for favorable metrics).
 * Positive z = above median (aging faster for favorable metrics).
 */
function valueToZScore(value, reference) {
  if (!reference || !value) return 0;
  const { p5, p50, p95 } = reference;
  if (p50 === undefined) return 0;

  const range = (p95 - p5) / 3.29; // ~1 SD = (p95-p5)/3.29
  return (value - p50) / range;
}

/**
 * Convert z-score to biological age offset (years).
 *
 * For favorable metrics (higher is better): positive z = older
 * For unfavorable metrics (lower is better): positive z = older (inverted)
 *
 * Calibrated so that +1 SD ≈ +3 years biological age offset
 */
function zScoreToBioAgeOffset(zScore, favorable = true) {
  const direction = favorable ? 1 : -1;
  return zScore * direction * 3; // ~3 years per SD
}

/**
 * Compute biological age from available biomarkers.
 *
 * @param {Object} params
 * @param {number} params.chronologicalAge - Age in years
 * @param {string} params.sex - 'male' or 'female'
 * @param {Object} params.wearableMetrics - Daily snapshot metrics
 * @param {Object} params.clinicLabs - Lab results
 * @param {Object} params.functionalAssessments - Functional test results
 *
 * @returns {Object} {
 *   biologicalAge,
 *   ageDelta,
 *   confidence,
 *   breakdown: [{ marker, value, reference, offset, weight, contribution }],
 *   lastUpdated
 * }
 */
function computeBiologicalAge({
  chronologicalAge,
  sex,
  wearableMetrics = {},
  clinicLabs = {},
  functionalAssessments = {},
}) {
  if (!chronologicalAge || chronologicalAge < 18) {
    throw new Error('Invalid chronological age');
  }

  if (!['male', 'female'].includes(sex)) {
    throw new Error('Invalid sex; use male or female');
  }

  const breakdown = [];
  let totalWeightedOffset = 0;
  let totalWeight = 0;
  let metricsAvailable = 0;

  // Weights: sum should not exceed 10 for reasonable age deltas
  // High weight: 2.0 (VO2, HRV, hs-CRP, grip strength)
  // Medium weight: 1.5 (resting HR, sleep, body composition)
  // Low weight: 1.0 (steps, lipids, glucose, BP)

  // ===== VO2 Max (High weight: 2.0) =====
  if (wearableMetrics.vo2_max != null) {
    const vo2 = wearableMetrics.vo2_max;
    const ref = getReference('vo2Max', chronologicalAge, sex);
    if (ref) {
      const z = valueToZScore(vo2, ref);
      const offset = zScoreToBioAgeOffset(z, true); // Higher VO2 = favorable
      const weight = 2.0;
      breakdown.push({
        marker: 'vo2_max',
        value: vo2,
        reference: ref,
        zScore: z,
        offset,
        weight,
        contribution: offset * weight,
      });
      totalWeightedOffset += offset * weight;
      totalWeight += weight;
      metricsAvailable++;
    }
  }

  // ===== HRV (High weight: 2.0) =====
  if (wearableMetrics.hrv != null) {
    const hrv = wearableMetrics.hrv;
    const ref = getReference('hrv', chronologicalAge, sex);
    if (ref) {
      const z = valueToZScore(hrv, ref);
      const offset = zScoreToBioAgeOffset(z, true); // Higher HRV = favorable
      const weight = 2.0;
      breakdown.push({
        marker: 'hrv',
        value: hrv,
        reference: ref,
        zScore: z,
        offset,
        weight,
        contribution: offset * weight,
      });
      totalWeightedOffset += offset * weight;
      totalWeight += weight;
      metricsAvailable++;
    }
  }

  // ===== Resting HR (Medium weight: 1.5) =====
  if (wearableMetrics.resting_hr != null) {
    const rhr = wearableMetrics.resting_hr;
    const ref = getReference('restingHR', chronologicalAge, sex);
    if (ref) {
      const z = valueToZScore(rhr, ref);
      const offset = zScoreToBioAgeOffset(z, false); // Lower RHR = favorable (inverted)
      const weight = 1.5;
      breakdown.push({
        marker: 'resting_hr',
        value: rhr,
        reference: ref,
        zScore: z,
        offset,
        weight,
        contribution: offset * weight,
      });
      totalWeightedOffset += offset * weight;
      totalWeight += weight;
      metricsAvailable++;
    }
  }

  // ===== hs-CRP (High weight: 2.0) =====
  if (clinicLabs.hs_crp_mg_l != null) {
    const crp = clinicLabs.hs_crp_mg_l;
    const ref = getReference('hsCRP', chronologicalAge, sex);
    if (ref) {
      const z = valueToZScore(crp, ref);
      const offset = zScoreToBioAgeOffset(z, false); // Lower CRP = favorable (inverted)
      const weight = 2.0;
      breakdown.push({
        marker: 'hs_crp_mg_l',
        value: crp,
        reference: ref,
        zScore: z,
        offset,
        weight,
        contribution: offset * weight,
      });
      totalWeightedOffset += offset * weight;
      totalWeight += weight;
      metricsAvailable++;
    }
  }

  // ===== Grip Strength (High weight: 2.0) =====
  const gripStrengthValue = functionalAssessments.grip_strength ??
                             clinicLabs.grip_strength ?? null;
  if (gripStrengthValue != null) {
    const grip = gripStrengthValue;
    const ref = getReference('gripStrength', chronologicalAge, sex);
    if (ref) {
      const z = valueToZScore(grip, ref);
      const offset = zScoreToBioAgeOffset(z, true); // Higher grip = favorable
      const weight = 2.0;
      breakdown.push({
        marker: 'grip_strength',
        value: grip,
        reference: ref,
        zScore: z,
        offset,
        weight,
        contribution: offset * weight,
      });
      totalWeightedOffset += offset * weight;
      totalWeight += weight;
      metricsAvailable++;
    }
  }

  // ===== Sleep Duration (Medium weight: 1.5) =====
  if (wearableMetrics.sleep_total_minutes != null) {
    const sleepHours = wearableMetrics.sleep_total_minutes / 60;
    const ref = getReference('sleepDuration', chronologicalAge, sex);
    if (ref) {
      const z = valueToZScore(sleepHours, ref);
      // Inverted: both too little and too much are bad
      // Create a "sweet spot" penalty for deviation from 7.5 hours
      const optimalSleep = 7.5;
      const sleepDeviation = Math.abs(sleepHours - optimalSleep);
      const sleepOffset = (sleepDeviation / 2) * (sleepDeviation > 1 ? 1 : 0.5);
      const weight = 1.5;
      breakdown.push({
        marker: 'sleep_total_hours',
        value: sleepHours,
        reference: ref,
        zScore: z,
        offset: sleepOffset,
        weight,
        contribution: sleepOffset * weight,
      });
      totalWeightedOffset += sleepOffset * weight;
      totalWeight += weight;
      metricsAvailable++;
    }
  }

  // ===== Body Fat % (Medium weight: 1.5) =====
  if (wearableMetrics.body_fat_percent != null || clinicLabs.body_fat_pct != null) {
    const bodyFat = wearableMetrics.body_fat_percent ?? clinicLabs.body_fat_pct;
    const ref = getReference('bodyFatPercent', chronologicalAge, sex);
    if (ref) {
      const z = valueToZScore(bodyFat, ref);
      const offset = zScoreToBioAgeOffset(z, false); // Higher body fat = unfavorable
      const weight = 1.5;
      breakdown.push({
        marker: 'body_fat_percent',
        value: bodyFat,
        reference: ref,
        zScore: z,
        offset,
        weight,
        contribution: offset * weight,
      });
      totalWeightedOffset += offset * weight;
      totalWeight += weight;
      metricsAvailable++;
    }
  }

  // ===== BMI (Medium weight: 1.0) =====
  if (wearableMetrics.weight_kg != null) {
    const heightM = wearableMetrics.height_m ?? 1.75; // Fallback if not provided
    const bmi = wearableMetrics.weight_kg / (heightM * heightM);
    const ref = getReference('bmi', chronologicalAge, sex);
    if (ref) {
      const z = valueToZScore(bmi, ref);
      const offset = zScoreToBioAgeOffset(z, false); // Higher BMI = unfavorable
      const weight = 1.0;
      breakdown.push({
        marker: 'bmi',
        value: Number(bmi.toFixed(1)),
        reference: ref,
        zScore: z,
        offset,
        weight,
        contribution: offset * weight,
      });
      totalWeightedOffset += offset * weight;
      totalWeight += weight;
      metricsAvailable++;
    }
  }

  // ===== Total Cholesterol (Low weight: 1.0) =====
  if (clinicLabs.total_cholesterol != null) {
    const chol = clinicLabs.total_cholesterol;
    const ref = getReference('totalCholesterol', chronologicalAge, sex);
    if (ref) {
      const z = valueToZScore(chol, ref);
      const offset = zScoreToBioAgeOffset(z, false); // Higher cholesterol = unfavorable
      const weight = 1.0;
      breakdown.push({
        marker: 'total_cholesterol',
        value: chol,
        reference: ref,
        zScore: z,
        offset,
        weight,
        contribution: offset * weight,
      });
      totalWeightedOffset += offset * weight;
      totalWeight += weight;
      metricsAvailable++;
    }
  }

  // ===== HDL Cholesterol (Low weight: 1.0) =====
  if (clinicLabs.hdl_cholesterol != null) {
    const hdl = clinicLabs.hdl_cholesterol;
    const ref = getReference('hdlCholesterol', chronologicalAge, sex);
    if (ref) {
      const z = valueToZScore(hdl, ref);
      const offset = zScoreToBioAgeOffset(z, true); // Higher HDL = favorable
      const weight = 1.0;
      breakdown.push({
        marker: 'hdl_cholesterol',
        value: hdl,
        reference: ref,
        zScore: z,
        offset,
        weight,
        contribution: offset * weight,
      });
      totalWeightedOffset += offset * weight;
      totalWeight += weight;
      metricsAvailable++;
    }
  }

  // ===== LDL Cholesterol (Low weight: 1.0) =====
  if (clinicLabs.ldl_cholesterol != null) {
    const ldl = clinicLabs.ldl_cholesterol;
    const ref = getReference('ldlCholesterol', chronologicalAge, sex);
    if (ref) {
      const z = valueToZScore(ldl, ref);
      const offset = zScoreToBioAgeOffset(z, false); // Higher LDL = unfavorable
      const weight = 1.0;
      breakdown.push({
        marker: 'ldl_cholesterol',
        value: ldl,
        reference: ref,
        zScore: z,
        offset,
        weight,
        contribution: offset * weight,
      });
      totalWeightedOffset += offset * weight;
      totalWeight += weight;
      metricsAvailable++;
    }
  }

  // ===== Triglycerides (Low weight: 1.0) =====
  if (clinicLabs.triglycerides != null) {
    const trig = clinicLabs.triglycerides;
    const ref = getReference('triglycerides', chronologicalAge, sex);
    if (ref) {
      const z = valueToZScore(trig, ref);
      const offset = zScoreToBioAgeOffset(z, false); // Higher triglycerides = unfavorable
      const weight = 1.0;
      breakdown.push({
        marker: 'triglycerides',
        value: trig,
        reference: ref,
        zScore: z,
        offset,
        weight,
        contribution: offset * weight,
      });
      totalWeightedOffset += offset * weight;
      totalWeight += weight;
      metricsAvailable++;
    }
  }

  // ===== Fasting Glucose (Low weight: 1.0) =====
  if (clinicLabs.fasting_glucose_mg_dl != null) {
    const glucose = clinicLabs.fasting_glucose_mg_dl;
    const ref = getReference('fastingGlucose', chronologicalAge, sex);
    if (ref) {
      const z = valueToZScore(glucose, ref);
      const offset = zScoreToBioAgeOffset(z, false); // Higher glucose = unfavorable
      const weight = 1.0;
      breakdown.push({
        marker: 'fasting_glucose_mg_dl',
        value: glucose,
        reference: ref,
        zScore: z,
        offset,
        weight,
        contribution: offset * weight,
      });
      totalWeightedOffset += offset * weight;
      totalWeight += weight;
      metricsAvailable++;
    }
  }

  // ===== Gait Speed (Medium weight: 1.5, only for 65+) =====
  if (chronologicalAge >= 65 && functionalAssessments.gait_speed_ms != null) {
    const gaitSpeed = functionalAssessments.gait_speed_ms;
    const ref = getReference('gaitSpeed', chronologicalAge, sex);
    if (ref) {
      const z = valueToZScore(gaitSpeed, ref);
      const offset = zScoreToBioAgeOffset(z, true); // Higher gait speed = favorable
      const weight = 1.5;
      breakdown.push({
        marker: 'gait_speed_ms',
        value: gaitSpeed,
        reference: ref,
        zScore: z,
        offset,
        weight,
        contribution: offset * weight,
      });
      totalWeightedOffset += offset * weight;
      totalWeight += weight;
      metricsAvailable++;
    }
  }

  // ===== Daily Steps (Low weight: 0.8) =====
  if (wearableMetrics.steps != null) {
    const steps = wearableMetrics.steps;
    // Simple heuristic: <5000 steps = +2 years, 5000-10000 = 0, >10000 = -1 year
    let stepsOffset = 0;
    if (steps < 5000) {
      stepsOffset = 2;
    } else if (steps > 10000) {
      stepsOffset = -1;
    }
    const weight = 0.8;
    breakdown.push({
      marker: 'steps',
      value: steps,
      reference: { p5: 3000, p50: 7500, p95: 12000 },
      zScore: 0, // Not using z-score for steps
      offset: stepsOffset,
      weight,
      contribution: stepsOffset * weight,
    });
    totalWeightedOffset += stepsOffset * weight;
    totalWeight += weight;
    metricsAvailable++;
  }

  // ===== Blood Pressure (Low weight: 1.0, simplified) =====
  if (wearableMetrics.bp_systolic != null || clinicLabs.bp_systolic != null) {
    const sysBP = wearableMetrics.bp_systolic ?? clinicLabs.bp_systolic;
    const diaBP = wearableMetrics.bp_diastolic ?? clinicLabs.bp_diastolic ?? 0;

    if (sysBP != null) {
      // Simple heuristic: <120 SBP = 0, 120-139 = +1.5, 140+ = +4
      let bpOffset = 0;
      if (sysBP >= 140) {
        bpOffset = 4;
      } else if (sysBP >= 120) {
        bpOffset = 1.5;
      }
      const weight = 1.0;
      breakdown.push({
        marker: 'blood_pressure',
        value: `${sysBP}/${diaBP}`,
        reference: { p5: 110, p50: 120, p95: 140 },
        zScore: 0,
        offset: bpOffset,
        weight,
        contribution: bpOffset * weight,
      });
      totalWeightedOffset += bpOffset * weight;
      totalWeight += weight;
      metricsAvailable++;
    }
  }

  // Calculate final biological age
  const weightedOffset = totalWeight > 0 ? totalWeightedOffset / totalWeight : 0;
  const biologicalAge = chronologicalAge + weightedOffset;

  // Confidence score based on number of available metrics (0-100)
  // 0-2 metrics: low confidence (50-60)
  // 3-4 metrics: medium confidence (60-75)
  // 5+ metrics: high confidence (75-95)
  let confidence = 50;
  if (metricsAvailable >= 5) {
    confidence = Math.min(95, 75 + (metricsAvailable - 5) * 2);
  } else if (metricsAvailable >= 3) {
    confidence = 60 + (metricsAvailable - 3) * 7.5;
  } else if (metricsAvailable > 0) {
    confidence = 50 + metricsAvailable * 5;
  }

  return {
    biologicalAge: Number(biologicalAge.toFixed(1)),
    ageDelta: Number(weightedOffset.toFixed(1)),
    confidence: Number(confidence.toFixed(0)),
    breakdown: breakdown.map(item => ({
      marker: item.marker,
      value: item.value,
      reference: {
        p5: Number((item.reference.p5 || 0).toFixed(2)),
        p50: Number((item.reference.p50 || 0).toFixed(2)),
        p95: Number((item.reference.p95 || 0).toFixed(2)),
      },
      zScore: Number((item.zScore || 0).toFixed(2)),
      offset: Number((item.offset || 0).toFixed(2)),
      weight: Number((item.weight || 0).toFixed(2)),
      contribution: Number((item.contribution || 0).toFixed(2)),
    })),
    metricsCount: metricsAvailable,
    lastUpdated: new Date().toISOString(),
  };
}

module.exports = {
  computeBiologicalAge,
  getReference,
  valueToZScore,
  zScoreToBioAgeOffset,
};
