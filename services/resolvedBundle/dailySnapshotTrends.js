// services/resolvedBundle/dailySnapshotTrends.js

const METRICS_V1 = [
  "resting_hr",
  "hrv",
  "sleep_duration",
  "sleep_efficiency",
  "steps",
  "activity_minutes",
  "respiratory_rate",
  "skin_temp_delta",
  "blood_oxygen",
];

const METRIC_EPSILON = {
  resting_hr: 1,
  hrv: 2,
  sleep_duration: 15,
  sleep_efficiency: 1,
  steps: 500,
  activity_minutes: 10,
  respiratory_rate: 0.5,
  skin_temp_delta: 0.05,
  blood_oxygen: 1,
};

function isNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(
    arr.reduce((s, v) => s + Math.pow(v - m, 2), 0) / (arr.length - 1)
  );
}

function coefficientOfVariation(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  if (m === 0) return null;
  return Math.abs(stddev(arr) / m);
}

function computeVolatility(values) {
  const nums = values.filter(isNumber);
  const cv = coefficientOfVariation(nums);
  if (cv === null) return "unknown";
  if (cv < 0.1) return "low";
  if (cv < 0.25) return "moderate";
  return "high";
}

function firstNonNull(values) {
  for (const v of values) if (isNumber(v)) return v;
  return null;
}

function lastNonNull(values) {
  for (let i = values.length - 1; i >= 0; i--) {
    if (isNumber(values[i])) return values[i];
  }
  return null;
}

function computeDirection(points, delta, epsilon) {
  if (points < 3 || delta === null) return "insufficient_data";
  if (Math.abs(delta) <= epsilon) return "stable";
  return delta > 0 ? "up" : "down";
}

function computeTrendStrength(coverage, volatility, direction) {
  if (direction === "insufficient_data") return "unknown";
  if (coverage >= 0.8 && volatility === "low") return "strong";
  if (coverage >= 0.5) return "moderate";
  return "weak";
}

function buildDailySnapshotTrends({ snapshots, bundleDayKey, windowDays }) {
  const trends = {};
  const startDayKey = snapshots.length ? snapshots[0].day_key : bundleDayKey;

  for (const metric of METRICS_V1) {
    const values = snapshots.map((s) => s[metric] ?? null);
    const numericValues = values.filter(isNumber);

    const baseline = firstNonNull(values);
    const latest = lastNonNull(values);
    const delta =
      baseline !== null && latest !== null ? latest - baseline : null;

    const pointsAvailable = numericValues.length;
    const coverageRatio = windowDays > 0 ? pointsAvailable / windowDays : 0;

    const volatility = computeVolatility(values);
    const direction = computeDirection(
      pointsAvailable,
      delta,
      METRIC_EPSILON[metric] ?? 0
    );

    trends[metric] = {
      window_days: windowDays,
      points_available: pointsAvailable,
      expected_points: windowDays,
      coverage_ratio: coverageRatio,
      latest_value: latest,
      baseline_value: baseline,
      delta,
      direction,
      volatility,
      trend_strength: computeTrendStrength(
        coverageRatio,
        volatility,
        direction
      ),
      data_gaps: windowDays - pointsAvailable,
      start_day_key: startDayKey,
      end_day_key: bundleDayKey,
    };
  }

  return trends;
}

module.exports = {
  METRICS_V1,
  METRIC_EPSILON,
  buildDailySnapshotTrends,
};
