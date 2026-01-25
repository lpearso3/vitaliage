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

function isoToDayKeyUTC(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
    case "resting_heart_rate":
      return s.resting_hr ?? null;

    case "spo2":
      return s.blood_oxygen ?? null;

    case "body_weight":
      return s.weight_kg ?? null;

    case "body_fat_percentage":
      return s.body_fat_pct ?? s.body_fat_percent ?? null;

    case "blood_pressure_systolic":
      return s.bp_systolic ?? null;

    case "blood_pressure_diastolic":
      return s.bp_diastolic ?? null;

    default:
      return null;
  }
}

function entry(v, src, a, d, q, p) {
  return {
    value: v,
    source: src, // legacy string used in downstream UI/debug ("ANCHOR_DEVICE" | "WEARABLE")
    measured_at: a,
    day_key: d,
    quality: q || "medium",
    protocol_version: p ?? null,
  };
}

/**
 * Provenance for confidence (server-side):
 * - source: "conneqt" | "wearable" | "tanita" | "charder" | "unknown"
 * - rule: "same-day" | "as-of" | "unknown"
 */
function prov(metricKey, source, rule, bundleDayKey, measuredAtIso, asOfDayKey, isNull) {
  return {
    metric_key: metricKey || null,
    source: source || "unknown",
    rule: rule || "unknown",
    day_key: bundleDayKey || null,
    as_of_day_key: asOfDayKey ?? null,
    measured_at: measuredAtIso ?? null,
    is_null: !!isNull,
  };
}

/**
 * Step 3 resolved metrics (downstream-only, excluded from bundle_hash):
 * - Same-day precedence for BP/HR (CONNEQT) > wearable, or wearable if present
 * - "As-of bundle day" for body comp (latest <= bundleDayKey) when provided
 * - Anchors can override wearables OR fill gaps when wearables are missing
 *
 * Returns:
 * {
 *   resolved_metrics: { ... },
 *   resolved_metrics_provenance: { ... }
 * }
 *
 * Hygiene:
 * - No confidence.* usage here.
 */
function buildResolvedMetrics({
  bundleDayKey,
  dailySnapshotForDay,
  sameDay = {},
  asOf = {},
}) {
  if (!bundleDayKey) throw new Error("bundleDayKey required");

  const r = {};
  const p = {};

  const con = pickLatestByMeasuredAt(sameDay?.conneqt || []);
  // asOf.tanita is canonical per your pipeline; fallback to sameDay.tanita for legacy compatibility
  const bc = pickLatestByMeasuredAt(asOf?.tanita || sameDay?.tanita || []);
  const bcAsOfDayKey = bc?.day_key ?? isoToDayKeyUTC(bc?.measured_at) ?? null;

  // BP: CONNEQT brachial (same-day) > wearable
  {
    if (con?.brachial_systolic != null && con?.brachial_diastolic != null) {
      r.blood_pressure_systolic = entry(
        +con.brachial_systolic,
        "ANCHOR_DEVICE",
        con.measured_at,
        bundleDayKey,
        con.quality,
        con.protocol_version
      );
      p.blood_pressure_systolic = prov(
        "blood_pressure_systolic",
        "conneqt",
        "same-day",
        bundleDayKey,
        con.measured_at,
        null,
        false
      );

      r.blood_pressure_diastolic = entry(
        +con.brachial_diastolic,
        "ANCHOR_DEVICE",
        con.measured_at,
        bundleDayKey,
        con.quality,
        con.protocol_version
      );
      p.blood_pressure_diastolic = prov(
        "blood_pressure_diastolic",
        "conneqt",
        "same-day",
        bundleDayKey,
        con.measured_at,
        null,
        false
      );
    } else {
      const sys = getWearableValueForMetric(
        dailySnapshotForDay,
        "blood_pressure_systolic"
      );
      const dia = getWearableValueForMetric(
        dailySnapshotForDay,
        "blood_pressure_diastolic"
      );

      if (sys != null) {
        r.blood_pressure_systolic = entry(
          +sys,
          "WEARABLE",
          null,
          bundleDayKey,
          "medium",
          null
        );
        p.blood_pressure_systolic = prov(
          "blood_pressure_systolic",
          "wearable",
          "same-day",
          bundleDayKey,
          null,
          null,
          false
        );
      }

      if (dia != null) {
        r.blood_pressure_diastolic = entry(
          +dia,
          "WEARABLE",
          null,
          bundleDayKey,
          "medium",
          null
        );
        p.blood_pressure_diastolic = prov(
          "blood_pressure_diastolic",
          "wearable",
          "same-day",
          bundleDayKey,
          null,
          null,
          false
        );
      }
    }
  }

  // Resting HR: CONNEQT heart_rate (same-day) > wearable resting_hr
  {
    if (con?.heart_rate != null) {
      r.resting_heart_rate = entry(
        +con.heart_rate,
        "ANCHOR_DEVICE",
        con.measured_at,
        bundleDayKey,
        con.quality,
        con.protocol_version
      );
      p.resting_heart_rate = prov(
        "resting_heart_rate",
        "conneqt",
        "same-day",
        bundleDayKey,
        con.measured_at,
        null,
        false
      );
    } else {
      const wearable = getWearableValueForMetric(
        dailySnapshotForDay,
        "resting_heart_rate"
      );
      if (wearable != null) {
        r.resting_heart_rate = entry(
          +wearable,
          "WEARABLE",
          null,
          bundleDayKey,
          "medium",
          null
        );
        p.resting_heart_rate = prov(
          "resting_heart_rate",
          "wearable",
          "same-day",
          bundleDayKey,
          null,
          null,
          false
        );
      }
    }
  }

  // Weight + body fat: body comp (as-of) > wearable
  {
    if (bc?.weight_kg != null) {
      r.body_weight = entry(
        +bc.weight_kg,
        "ANCHOR_DEVICE",
        bc.measured_at,
        bundleDayKey,
        bc.quality,
        bc.protocol_version
      );
      // Source may be tanita or charder depending on device; keep deterministic default "tanita"
      p.body_weight = prov(
        "body_weight",
        bc?.device === "charder" ? "charder" : "tanita",
        "as-of",
        bundleDayKey,
        bc.measured_at,
        bcAsOfDayKey,
        false
      );
    } else {
      const w = getWearableValueForMetric(dailySnapshotForDay, "body_weight");
      if (w != null) {
        r.body_weight = entry(+w, "WEARABLE", null, bundleDayKey, "medium", null);
        p.body_weight = prov(
          "body_weight",
          "wearable",
          "same-day",
          bundleDayKey,
          null,
          null,
          false
        );
      }
    }

    if (bc?.body_fat_pct != null) {
      r.body_fat_percentage = entry(
        +bc.body_fat_pct,
        "ANCHOR_DEVICE",
        bc.measured_at,
        bundleDayKey,
        bc.quality,
        bc.protocol_version
      );
      p.body_fat_percentage = prov(
        "body_fat_percentage",
        bc?.device === "charder" ? "charder" : "tanita",
        "as-of",
        bundleDayKey,
        bc.measured_at,
        bcAsOfDayKey,
        false
      );
    } else {
      const bf = getWearableValueForMetric(
        dailySnapshotForDay,
        "body_fat_percentage"
      );
      if (bf != null) {
        r.body_fat_percentage = entry(
          +bf,
          "WEARABLE",
          null,
          bundleDayKey,
          "medium",
          null
        );
        p.body_fat_percentage = prov(
          "body_fat_percentage",
          "wearable",
          "same-day",
          bundleDayKey,
          null,
          null,
          false
        );
      }
    }
  }

  // SpO2: wearable only for now (until you add an anchor type)
  {
    const s = getWearableValueForMetric(dailySnapshotForDay, "spo2");
    if (s != null) {
      r.spo2 = entry(+s, "WEARABLE", null, bundleDayKey, "medium", null);
      p.spo2 = prov("spo2", "wearable", "same-day", bundleDayKey, null, null, false);
    }
  }

  // Filter to eligible metrics only
  const resolved_metrics = {};
  const resolved_metrics_provenance = {};
  for (const k of Object.keys(r)) {
    if (ELIGIBLE_METRICS.includes(k)) {
      resolved_metrics[k] = r[k];
      if (p[k]) resolved_metrics_provenance[k] = p[k];
    }
  }

  return { resolved_metrics, resolved_metrics_provenance };
}

module.exports = { buildResolvedMetrics };
