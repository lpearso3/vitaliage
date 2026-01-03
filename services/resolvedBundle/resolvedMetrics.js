// services/resolvedBundle/resolvedMetrics.js

const ELIGIBLE_METRICS = Object.freeze([
  "blood_pressure_systolic",
  "blood_pressure_diastolic",
  "resting_heart_rate",
  "body_weight",
  "body_fat_percentage",
  "spo2",
]);

function isoToMs(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : -Infinity;
}

function pickLatestByMeasuredAt(rows) {
  let best = null;
  let bestT = -Infinity;
  for (const r of rows || []) {
    const t = isoToMs(r?.measured_at);
    if (t > bestT) {
      best = r;
      bestT = t;
    }
  }
  return best;
}

function getWearableValueForMetric(s, metric) {
  if (!s) return null;
  switch (metric) {
    case "resting_heart_rate": return s.resting_hr ?? null;
    case "spo2": return s.blood_oxygen ?? null;
    case "body_weight": return s.weight_kg ?? null;
    case "body_fat_percentage": return s.body_fat_pct ?? null;
    case "blood_pressure_systolic": return s.bp_systolic ?? null;
    case "blood_pressure_diastolic": return s.bp_diastolic ?? null;
    default: return null;
  }
}

function entry(v, src, a, d, q, p) {
  return {
    value: v,
    source: src,
    measured_at: a,
    day_key: d,
    quality: q || "medium",
    protocol_version: p ?? null,
  };
}

function buildResolvedMetrics({ bundleDayKey, dailySnapshotForDay, sameDay }) {
  if (!bundleDayKey) throw new Error("bundleDayKey required");

  const r = {};

  // BP: CONNEQT brachial > wearable (same day only)
  {
    const sys = getWearableValueForMetric(dailySnapshotForDay, "blood_pressure_systolic");
    const dia = getWearableValueForMetric(dailySnapshotForDay, "blood_pressure_diastolic");
    if (sys !== null && dia !== null) {
      const bp = pickLatestByMeasuredAt(sameDay?.conneqt || []);
      if (bp?.brachial_systolic != null && bp?.brachial_diastolic != null) {
        r.blood_pressure_systolic = entry(+bp.brachial_systolic, "ANCHOR_DEVICE", bp.measured_at, bundleDayKey, bp.quality, bp.protocol_version);
        r.blood_pressure_diastolic = entry(+bp.brachial_diastolic, "ANCHOR_DEVICE", bp.measured_at, bundleDayKey, bp.quality, bp.protocol_version);
      }
    }
  }

  // Resting HR
  {
    const wearable = getWearableValueForMetric(dailySnapshotForDay, "resting_heart_rate");
    if (wearable !== null) {
      const hr = pickLatestByMeasuredAt(sameDay?.conneqt || []);
      if (hr?.heart_rate != null) {
        r.resting_heart_rate = entry(+hr.heart_rate, "ANCHOR_DEVICE", hr.measured_at, bundleDayKey, hr.quality, hr.protocol_version);
      }
    }
  }

  // Weight + body fat
  {
    const t = pickLatestByMeasuredAt(sameDay?.tanita || []);
    if (t) {
      if (getWearableValueForMetric(dailySnapshotForDay, "body_weight") !== null && t.weight_kg != null) {
        r.body_weight = entry(+t.weight_kg, "ANCHOR_DEVICE", t.measured_at, bundleDayKey, t.quality, t.protocol_version);
      }
      if (getWearableValueForMetric(dailySnapshotForDay, "body_fat_percentage") !== null && t.body_fat_pct != null) {
        r.body_fat_percentage = entry(+t.body_fat_pct, "ANCHOR_DEVICE", t.measured_at, bundleDayKey, t.quality, t.protocol_version);
      }
    }
  }

  return Object.keys(r).length ? r : null;
}

module.exports = { buildResolvedMetrics };
