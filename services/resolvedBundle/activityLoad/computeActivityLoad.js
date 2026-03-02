// services/resolvedBundle/activityLoad/computeActivityLoad.js

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function sortByDayKeyAsc(snaps) {
  return [...snaps].sort((a, b) =>
    String(a.day_key || "").localeCompare(String(b.day_key || ""))
  );
}

/**
 * Canonical activity load (wearable-only)
 * Measures daily physical demand/exertion (analogous to readiness but for load rather than recovery)
 * Input: normalized snapshots (services/resolvedBundle/normalizeDailySnapshot.js output)
 * Output shape: matches ActivityLoad schema
 */
function computeActivityLoadFromSnapshots(snapshots /*, profileOverride */) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return {
      score: 50,
      state: "moderate_load",
      label: "Moderate Activity",
      reasons: ["Not enough data yet to calculate activity load."],
      components: {
        stepsScore: 50,
        activeMinutesScore: 50,
        heartLoadScore: 50,
        stepsAvg: null,
        activeMinutesAvg: null,
      },
    };
  }

  // Sort ASC and keep last 7 days
  const snaps = sortByDayKeyAsc(snapshots).slice(-7);
  const n = snaps.length;
  const today = snaps[n - 1];

  // ---- Steps Component (30%) ----
  // 0-3000 steps = 20, 3000-7000 = linear 20-60, 7000-12000 = linear 60-90, 12000+ = 100
  const stepValues = snaps
    .map((s) => (typeof s.steps === "number" ? s.steps : null))
    .filter((v) => v != null);

  const stepsAvg =
    stepValues.length > 0
      ? stepValues.reduce((a, b) => a + b, 0) / stepValues.length
      : null;

  let stepsScore = 50;
  if (stepsAvg != null) {
    if (stepsAvg <= 3000) {
      stepsScore = 20;
    } else if (stepsAvg >= 12000) {
      stepsScore = 100;
    } else if (stepsAvg < 7000) {
      // Linear 20-60 for 3000-7000
      const t = (stepsAvg - 3000) / 4000;
      stepsScore = Math.round(20 + t * 40);
    } else {
      // Linear 60-90 for 7000-12000
      const t = (stepsAvg - 7000) / 5000;
      stepsScore = Math.round(60 + t * 30);
    }
  }

  // ---- Active Minutes Component (35%) ----
  // 0 min = 10, 0-30 = linear 10-50, 30-60 = linear 50-80, 60-90 = linear 80-95, 90+ = 100
  const activeMinutesValues = snaps
    .map((s) => (typeof s.activity_minutes === "number" ? s.activity_minutes : null))
    .filter((v) => v != null);

  const activeMinutesAvg =
    activeMinutesValues.length > 0
      ? activeMinutesValues.reduce((a, b) => a + b, 0) / activeMinutesValues.length
      : null;

  let activeMinutesScore = 50;
  if (activeMinutesAvg != null) {
    if (activeMinutesAvg === 0) {
      activeMinutesScore = 10;
    } else if (activeMinutesAvg >= 90) {
      activeMinutesScore = 100;
    } else if (activeMinutesAvg <= 30) {
      // Linear 10-50 for 0-30
      const t = activeMinutesAvg / 30;
      activeMinutesScore = Math.round(10 + t * 40);
    } else if (activeMinutesAvg <= 60) {
      // Linear 50-80 for 30-60
      const t = (activeMinutesAvg - 30) / 30;
      activeMinutesScore = Math.round(50 + t * 30);
    } else {
      // Linear 80-95 for 60-90
      const t = (activeMinutesAvg - 60) / 30;
      activeMinutesScore = Math.round(80 + t * 15);
    }
  }

  // ---- Heart Load Component (35%) ----
  // Base 50, +/- adjustments from HR and HRV deltas vs 7-day average
  // Higher resting HR today vs avg = higher load (+3 per bpm above avg)
  // Lower HRV today vs avg = higher load (+0.5 per % below avg)
  const rhrValues = snaps
    .map((s) => (typeof s.resting_hr === "number" ? s.resting_hr : null))
    .filter((v) => v != null);

  const rhrAvg =
    rhrValues.length > 0
      ? rhrValues.reduce((a, b) => a + b, 0) / rhrValues.length
      : null;

  const rhrToday = typeof today.resting_hr === "number" ? today.resting_hr : null;

  const hrvValues = snaps
    .map((s) => (typeof s.hrv === "number" ? s.hrv : null))
    .filter((v) => v != null);

  const hrvAvg =
    hrvValues.length > 0
      ? hrvValues.reduce((a, b) => a + b, 0) / hrvValues.length
      : null;

  const hrvToday = typeof today.hrv === "number" ? today.hrv : null;

  let heartLoadScore = 50;
  let rhrDelta = null;
  let hrvDeltaPct = null;

  if (rhrToday != null && rhrAvg != null) {
    rhrDelta = rhrToday - rhrAvg;
    heartLoadScore += rhrDelta * 3; // Each bpm above avg adds 3 points to load
  }

  if (hrvToday != null && hrvAvg != null && hrvAvg > 0) {
    hrvDeltaPct = ((hrvToday - hrvAvg) / hrvAvg) * 100;
    heartLoadScore += Math.max(0, -hrvDeltaPct) * 0.5; // Each % below avg adds 0.5 points to load
  }

  heartLoadScore = Math.round(clamp(heartLoadScore, 0, 100));

  // ---- Weights & composite ----
  const baseWeights = { steps: 0.3, activeMinutes: 0.35, heartLoad: 0.35 };
  const weights = { ...baseWeights };

  function normalizeWeights(mask) {
    let total = 0;
    for (const k of Object.keys(weights)) {
      if (mask[k]) total += weights[k];
      else weights[k] = 0;
    }
    if (total <= 0) return;
    for (const k of Object.keys(weights)) {
      if (mask[k]) weights[k] = weights[k] / total;
    }
  }

  normalizeWeights({
    steps: stepsAvg != null,
    activeMinutes: activeMinutesAvg != null,
    heartLoad: (rhrAvg != null && rhrToday != null) || (hrvAvg != null && hrvToday != null),
  });

  const rawScore =
    stepsScore * weights.steps +
    activeMinutesScore * weights.activeMinutes +
    heartLoadScore * weights.heartLoad;

  const finalScore = clamp(Math.round(rawScore), 0, 100);

  let state = "moderate_load";
  let label = "Moderate Activity";

  if (finalScore >= 70) {
    state = "high_load";
    label = "High Activity";
  } else if (finalScore < 40) {
    state = "light_load";
    label = "Light Activity";
  }

  const reasons = [];

  if (stepsAvg != null) {
    if (stepsAvg >= 10000) reasons.push("Step activity has been very high.");
    else if (stepsAvg >= 7000) reasons.push("Step activity has been solid.");
    else if (stepsAvg <= 3000) reasons.push("Step activity has been low.");
  }

  if (activeMinutesAvg != null) {
    if (activeMinutesAvg >= 60) reasons.push("Active minutes have been substantial.");
    else if (activeMinutesAvg >= 30) reasons.push("Active minutes have been moderate.");
    else if (activeMinutesAvg > 0) reasons.push("Active minutes have been limited.");
    else reasons.push("No recorded active minutes.");
  }

  if (rhrDelta != null) {
    if (rhrDelta >= 5) reasons.push("Resting heart rate is elevated, suggesting higher demand.");
    else if (rhrDelta <= -5) reasons.push("Resting heart rate is lower than usual.");
  }

  if (hrvDeltaPct != null) {
    if (hrvDeltaPct <= -15) reasons.push("HRV is reduced, suggesting increased physical stress.");
    else if (hrvDeltaPct >= 15) reasons.push("HRV is elevated, suggesting good recovery capacity.");
  }

  if (reasons.length === 0) reasons.push("Limited data, so this activity load is approximate.");

  return {
    score: finalScore,
    state,
    label,
    reasons,
    components: {
      stepsScore,
      activeMinutesScore,
      heartLoadScore,
      stepsAvg,
      activeMinutesAvg,
    },
  };
}

module.exports = { computeActivityLoadFromSnapshots };
