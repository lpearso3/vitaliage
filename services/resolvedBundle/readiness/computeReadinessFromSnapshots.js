// services/resolvedBundle/readiness/computeReadinessFromSnapshots.js

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
 * Canonical readiness (wearable-only)
 * Input: normalized snapshots (services/resolvedBundle/normalizeDailySnapshot.js output)
 * Output shape: matches OpenAPI Readiness schema
 */
function computeReadinessFromSnapshots(snapshots /*, profileOverride */) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return {
      score: 50,
      state: "easy",
      reasons: ["Not enough data yet to calculate readiness."],
      components: {
        sleepScore: 50,
        hrvScore: 50,
        rhrScore: 50,
        stepsScore: 50,
        sleep7DayAdherence: null,
        nightsMeetingGoal: null,
        hrvDeltaPct: null,
        rhrDelta: null,
        stepsAvg: null,
      },
      readinessScore: 50,
      stepsAvg: null,
    };
  }

  // Sort ASC and keep last 7 days
  const snaps = sortByDayKeyAsc(snapshots).slice(-7);
  const n = snaps.length;
  const today = snaps[n - 1];

  // ---- Sleep ----
  // We only have sleep_duration (hours). Use fixed 8h goal for now (deterministic).
  const sleepGoalHours = 8;

  let sleepHoursSum = 0;
  let sleepGoalHoursSum = 0;
  let nightsWithSleep = 0;
  let nightsMeetingGoal = 0;

  for (const s of snaps) {
    const h = typeof s.sleep_duration === "number" ? s.sleep_duration : null;
    if (h != null) {
      sleepHoursSum += h;
      sleepGoalHoursSum += sleepGoalHours;
      nightsWithSleep += 1;
      if (h >= sleepGoalHours) nightsMeetingGoal += 1;
    }
  }

  const sleep7DayAdherence =
    sleepGoalHoursSum > 0 ? sleepHoursSum / sleepGoalHoursSum : null;

  let sleepScore = 50;
  if (sleep7DayAdherence != null) {
    const ratio = Math.min(sleep7DayAdherence, 1.2);
    sleepScore = Math.round(clamp(ratio * 100, 0, 100));
    if (sleepScore < 50 && nightsMeetingGoal >= 4) {
      sleepScore = Math.max(sleepScore, 60);
    }
  }

  // ---- HRV ----
  const hrvValues = snaps
    .map((s) => (typeof s.hrv === "number" ? s.hrv : null))
    .filter((v) => v != null);

  const hrvToday = typeof today.hrv === "number" ? today.hrv : null;
  const hrvAvg =
    hrvValues.length > 0
      ? hrvValues.reduce((a, b) => a + b, 0) / hrvValues.length
      : null;

  let hrvDeltaPct = null;
  let hrvScore = 50;

  if (hrvToday != null && hrvAvg != null && hrvAvg > 0) {
    hrvDeltaPct = ((hrvToday - hrvAvg) / hrvAvg) * 100;
    const raw = 50 + (hrvDeltaPct / 20) * 50;
    hrvScore = Math.round(clamp(raw, 0, 100));
  }

  // ---- Resting HR ----
  const rhrValues = snaps
    .map((s) => (typeof s.resting_hr === "number" ? s.resting_hr : null))
    .filter((v) => v != null);

  const rhrToday = typeof today.resting_hr === "number" ? today.resting_hr : null;
  const rhrAvg =
    rhrValues.length > 0
      ? rhrValues.reduce((a, b) => a + b, 0) / rhrValues.length
      : null;

  let rhrDelta = null;
  let rhrScore = 50;

  if (rhrToday != null && rhrAvg != null) {
    rhrDelta = rhrToday - rhrAvg; // + is worse
    let raw;
    if (rhrDelta >= 15) raw = 0;
    else if (rhrDelta <= -10) raw = 100;
    else {
      const range = 25; // from -10 to +15
      const pos = (15 - rhrDelta) / range; // 0–1
      raw = pos * 100;
    }
    rhrScore = Math.round(clamp(raw, 0, 100));
  }

  // ---- Steps ----
  const stepValues = snaps
    .map((s) => (typeof s.steps === "number" ? s.steps : null))
    .filter((v) => v != null);

  const stepsAvg =
    stepValues.length > 0
      ? stepValues.reduce((a, b) => a + b, 0) / stepValues.length
      : null;

  let stepsScore = 50;
  if (stepsAvg != null) {
    if (stepsAvg <= 3000) stepsScore = 40;
    else if (stepsAvg >= 10000) stepsScore = 100;
    else {
      const t = (stepsAvg - 3000) / 7000;
      stepsScore = Math.round(40 + t * 60);
    }
  }

  // ---- Weights & composite ----
  const baseWeights = { sleep: 0.4, hrv: 0.3, rhr: 0.2, steps: 0.1 };
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
    sleep: sleep7DayAdherence != null,
    hrv: hrvAvg != null && hrvToday != null,
    rhr: rhrAvg != null && rhrToday != null,
    steps: stepsAvg != null,
  });

  const rawScore =
    sleepScore * weights.sleep +
    hrvScore * weights.hrv +
    rhrScore * weights.rhr +
    stepsScore * weights.steps;

  const finalScore = clamp(Math.round(rawScore), 0, 100);

  let state = "easy";
  if (finalScore >= 70) state = "ready";
  else if (finalScore <= 40) state = "rest";

  const reasons = [];

  if (sleep7DayAdherence != null) {
    const pct = Math.round(sleep7DayAdherence * 100);
    if (pct >= 95) reasons.push("Sleep has been on target most nights.");
    else if (pct <= 75) reasons.push("Sleep has been below your target recently.");
  }

  if (hrvDeltaPct != null) {
    if (hrvDeltaPct >= 15) reasons.push("HRV is well above your usual baseline.");
    else if (hrvDeltaPct <= -15) reasons.push("HRV is below your usual baseline.");
  }

  if (rhrDelta != null) {
    if (rhrDelta <= -5) reasons.push("Resting heart rate is lower than usual.");
    else if (rhrDelta >= 5) reasons.push("Resting heart rate is higher than usual.");
  }

  if (stepsAvg != null) {
    if (stepsAvg >= 8000) reasons.push("Activity levels have been solid.");
    else if (stepsAvg <= 4000) reasons.push("Activity has been on the lower side.");
  }

  if (reasons.length === 0) reasons.push("Limited data, so this readiness is approximate.");

  return {
    score: finalScore,
    state,
    reasons,
    components: {
      sleepScore,
      hrvScore,
      rhrScore,
      stepsScore,
      sleep7DayAdherence,
      nightsMeetingGoal: nightsWithSleep ? nightsMeetingGoal : null,
      hrvDeltaPct,
      rhrDelta,
      stepsAvg,
    },
    readinessScore: finalScore,
    stepsAvg,
  };
}

module.exports = { computeReadinessFromSnapshots };
