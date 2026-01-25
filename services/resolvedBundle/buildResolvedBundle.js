// services/resolvedBundle/buildResolvedBundle.js
const crypto = require("crypto");

const { buildDailySnapshotTrends } = require("./dailySnapshotTrends");
const { buildResolvedMetrics } = require("./resolvedMetrics");
const { normalizeDailySnapshot } = require("./normalizeDailySnapshot");
const { computeConfidence } = require("./confidence/computeConfidence");
const { buildProvenanceSummary } = require("./provenanceSummary");
const { buildFlags } = require("./flags/buildFlags");

/**
 * Deterministic JSON stringify with stable key ordering.
 * - Sorts object keys lexicographically at every level
 * - Preserves array order
 * - Omits undefined values (JSON behavior)
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const keys = Object.keys(value).sort();
  const props = keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);

  return `{${props.join(",")}}`;
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Deterministically dedupe multiple daily_snapshots rows for the same day_key.
 * Rule: keep latest created_at; tie-break by id.
 * Returns rows sorted by day_key ASC.
 */
function dedupeDailySnapshotsByDayKey(rows) {
  const bestByDay = new Map();

  for (const r of rows || []) {
    const day = r?.day_key;
    if (!day) continue;

    const prev = bestByDay.get(day);
    if (!prev) {
      bestByDay.set(day, r);
      continue;
    }

    const tPrev = Date.parse(prev.created_at || "") || -Infinity;
    const tCurr = Date.parse(r.created_at || "") || -Infinity;

    if (tCurr > tPrev) {
      bestByDay.set(day, r);
    } else if (tCurr === tPrev) {
      const a = String(prev.id || "");
      const b = String(r.id || "");
      if (b > a) bestByDay.set(day, r);
    }
  }

  return Array.from(bestByDay.values()).sort((a, b) =>
    String(a.day_key).localeCompare(String(b.day_key))
  );
}

/**
 * buildResolvedBundle({ supabase, userId, bundleDayKey, windowDays })
 * Returns the canonical ResolvedBundle shape.
 *
 * Canon:
 * - Step 1: raw inputs from daily_snapshots table (immutable)
 * - Step 1.5: normalization (in-memory only)
 * - Step 2: deterministic trends from normalized snapshots (hashed)
 * - Step 3: resolved_metrics + provenance (excluded from hash)
 * - confidence, flags, provenance_summary are excluded from hash
 *
 * Hygiene audit:
 * - This file must never reference confidence.metrics.
 * - Only confidence.overall / confidence.trends / confidence.resolved are valid.
 */
async function buildResolvedBundle({
  supabase,
  userId = null,
  bundleDayKey,
  windowDays = 28,
}) {
  if (!bundleDayKey) {
    throw new Error("bundleDayKey is required (UTC day_key, e.g. 2026-01-02)");
  }
  if (!supabase) {
    throw new Error("supabase client is required");
  }

  const window_days = Number(windowDays) || 28;

  function subtractDays(dayKey, days) {
    const [y, m, d] = dayKey.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - days);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  async function latestFrom(table, selectCols) {
    let q = supabase
      .from(table)
      .select(selectCols)
      .order("measured_at", { ascending: false })
      .limit(1);

    // user_id is nullable; only filter if userId provided
    if (userId) q = q.eq("user_id", userId);

    const { data, error } = await q;
    if (error) {
      throw new Error(
        `latestFrom ${table} failed: ${error.message || error.code}`
      );
    }
    return data?.[0] || null;
  }

  async function allForDay(table, selectCols, dayKey) {
    let q = supabase
      .from(table)
      .select(selectCols)
      .eq("day_key", dayKey)
      .order("measured_at", { ascending: false });

    if (userId) q = q.eq("user_id", userId);

    const { data, error } = await q;
    if (error) {
      throw new Error(
        `allForDay ${table} failed: ${error.message || error.code}`
      );
    }
    return data || [];
  }

  async function latestUpToDay(table, selectCols, dayKey) {
    let q = supabase
      .from(table)
      .select(selectCols)
      .lte("day_key", dayKey)
      .order("day_key", { ascending: false })
      .order("measured_at", { ascending: false })
      .limit(1);

    if (userId) q = q.eq("user_id", userId);

    const { data, error } = await q;
    if (error) {
      throw new Error(
        `latestUpToDay ${table} failed: ${error.message || error.code}`
      );
    }
    return data?.[0] || null;
  }

  // --- Step 2: daily_snapshots selection (locked rules) ---
  const startExclusive = subtractDays(bundleDayKey, window_days);

  let dsQuery = supabase
    .from("daily_snapshots")
    .select("*")
    .lte("snapshot_date", bundleDayKey)
    .gt("snapshot_date", startExclusive)
    .order("snapshot_date", { ascending: true });

  if (userId) dsQuery = dsQuery.eq("user_id", userId);

  const { data: dailySnapshots, error: dsError } = await dsQuery;
  if (dsError) {
    throw new Error(
      `daily_snapshots window fetch failed: ${dsError.message || dsError.code}`
    );
  }

  // Normalize -> dedupe: deterministically enforce "one snapshot per day_key"
  const snapshots = dedupeDailySnapshotsByDayKey(
    (dailySnapshots || []).map(normalizeDailySnapshot)
  );

  const daily_snapshot_trends = buildDailySnapshotTrends({
    snapshots,
    bundleDayKey,
    windowDays: window_days,
  });
  // --- end Step 2 ---

  // Anchors (v1 baseline) — excluded from Step 2 trend calc and excluded from hash
  const [conneqt, tanita, grip, rmr] = await Promise.all([
    latestFrom(
      "conneqt_assessments",
      "id,user_id,measured_at,day_key,quality,device,operator,conditions,brachial_systolic,brachial_diastolic,central_systolic,central_diastolic,heart_rate,augmentation_index,augmentation_pressure,pulse_pressure_amplification,sevr,central_pulse_pressure,arterial_age,report_pdf_url,raw_json"
    ),
    latestFrom(
      "tanita_assessments",
      "id,user_id,measured_at,day_key,quality,device,operator,conditions,weight_kg,body_fat_pct,fat_mass_kg,fat_free_mass_kg,muscle_mass_kg,tbw_pct,tbw_kg,visceral_fat_rating,bmr_kcal,metabolic_age,raw_json"
    ),
    latestFrom(
      "grip_strength_assessments",
      "id,user_id,measured_at,day_key,quality,device,operator,conditions,unit,left_best,right_best,notes,raw_json"
    ),
    latestFrom(
      "rmr_assessments",
      "id,user_id,measured_at,day_key,quality,device,operator,conditions,rmr_kcal_day,vo2_ml_min,vco2_ml_min,rer,steady_state_minutes,protocol,notes,raw_json"
    ),
  ]);

  // --- Step 3: precedence-aware resolution ---
  const dailySnapshotForDay =
    snapshots.find((s) => s.day_key === bundleDayKey) || null;

  const [sameDayConneqt, asOfTanita] = await Promise.all([
    allForDay(
      "conneqt_assessments",
      "id,user_id,measured_at,day_key,quality,device,brachial_systolic,brachial_diastolic,heart_rate,raw_json",
      bundleDayKey
    ),
    latestUpToDay(
      "tanita_assessments",
      "id,user_id,measured_at,day_key,quality,device,weight_kg,body_fat_pct,raw_json",
      bundleDayKey
    ),
  ]);

  const step3 = buildResolvedMetrics({
    bundleDayKey,
    dailySnapshotForDay,
    sameDay: { conneqt: sameDayConneqt },
    asOf: { tanita: asOfTanita ? [asOfTanita] : [] },
  });

  const resolved_metrics = step3?.resolved_metrics || {};
  const resolved_metrics_provenance = step3?.resolved_metrics_provenance || {};
  // --- end Step 3 ---

  // Confidence (excluded from hash)
  const confidence = computeConfidence({
    bundleDayKey,
    windowDays: window_days,
    dailySnapshotTrends: daily_snapshot_trends,
    resolvedMetrics: resolved_metrics,
    resolvedMetricsProvenance: resolved_metrics_provenance,
  });

  // Enforce confidence shape and prevent any downstream usage of confidence.metrics
  if (!confidence || typeof confidence !== "object") {
    throw new Error("computeConfidence returned invalid confidence object");
  }
  if (Object.prototype.hasOwnProperty.call(confidence, "metrics")) {
    throw new Error(
      "Invalid confidence shape: confidence.metrics is not allowed. Use confidence.trends and confidence.resolved."
    );
  }
  if (!confidence.overall || !confidence.trends || !confidence.resolved) {
    throw new Error(
      "Invalid confidence shape: confidence must include overall, trends, and resolved"
    );
  }

  // Provenance summary (excluded from hash)
  const provenance_summary = buildProvenanceSummary({
    dailySnapshotTrends: daily_snapshot_trends,
    resolvedMetricsProvenance: resolved_metrics_provenance,
    confidence,
  });

  // Flags (excluded from hash)
  const flags = buildFlags({
    bundleDayKey,
    dailySnapshotTrends: daily_snapshot_trends,
    resolvedMetricsProvenance: resolved_metrics_provenance,
    confidence,
  });

  const baseBundle = {
    user_id: userId,
    bundle_day_key: bundleDayKey,
    window_days,

    // Step 2 output (hashed inputs only; trends themselves are not directly hashed)
    daily_snapshot_trends,

    // normalized, read-only
    daily_snapshots: snapshots,

    // anchors (excluded from hash)
    latest_anchors: {
      conneqt,
      tanita,
      grip,
      rmr,
    },

    // Step 3 (excluded from hash)
    resolved_metrics,
    resolved_metrics_provenance,

    // Placeholders / downstream-only (excluded from hash)
    derived_metrics: {},
    confidence,
    flags,
    provenance_summary,
  };

  // Step 2 canonical hash payload (anchors + resolved_metrics + confidence + flags + summaries excluded).
  const hashPayload = {
    bundle_day_key: bundleDayKey,
    window_days,
    daily_snapshots: snapshots.map((s) => ({
      id: s.id,
      day_key: s.day_key,

      // Canonical Step 2 keys
      resting_hr: s.resting_hr ?? null,
      hrv: s.hrv ?? null,
      sleep_duration: s.sleep_duration ?? null,
      sleep_efficiency: s.sleep_efficiency ?? null,
      steps: s.steps ?? null,
      activity_minutes: s.activity_minutes ?? null,
      respiratory_rate: s.respiratory_rate ?? null,
      skin_temp_delta: s.skin_temp_delta ?? null,
      blood_oxygen: s.blood_oxygen ?? null,
    })),
  };

  const bundle_hash = sha256Hex(stableStringify(hashPayload));

  return { ...baseBundle, bundle_hash };
}

module.exports = { buildResolvedBundle };
