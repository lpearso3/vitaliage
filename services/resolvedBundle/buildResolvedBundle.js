// services/resolvedBundle/buildResolvedBundle.js
const crypto = require("crypto");
const { buildDailySnapshotTrends } = require("./dailySnapshotTrends");

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
 * buildResolvedBundle({ supabase, userId, bundleDayKey, windowDays })
 * Returns the canonical ResolvedBundle shape.
 *
 * v1 baseline: includes latest_anchors (conneqt, tanita, grip, rmr) using "latest wins".
 * Step 2: populates daily_snapshot_trends deterministically from immutable daily_snapshots only.
 *
 * Step 2 bundle_hash canon:
 * - MUST change when: bundle_day_key, window_days, or any daily_snapshot in-window changes
 * - MUST NOT include: anchors, interpretation, confidence, AI outputs
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

    // user_id is nullable in your schema; only filter if userId provided
    if (userId) q = q.eq("user_id", userId);

    const { data, error } = await q;
    if (error) {
      throw new Error(
        `latestFrom ${table} failed: ${error.message || error.code}`
      );
    }
    return data?.[0] || null;
  }

  // --- Step 2: daily_snapshots selection (locked rules) ---
  const startExclusive = subtractDays(bundleDayKey, window_days);

  let dsQuery = supabase
    .from("daily_snapshots")
    .select("*")
    .lte("day_key", bundleDayKey)
    .gt("day_key", startExclusive)
    .order("day_key", { ascending: true });

  if (userId) dsQuery = dsQuery.eq("user_id", userId);

  const { data: dailySnapshots, error: dsError } = await dsQuery;
  if (dsError) {
    throw new Error(
      `daily_snapshots window fetch failed: ${dsError.message || dsError.code}`
    );
  }

  const snapshots = dailySnapshots || [];

  const daily_snapshot_trends = buildDailySnapshotTrends({
    snapshots,
    bundleDayKey,
    windowDays: window_days,
  });
  // --- end Step 2 ---

  // Anchors (v1 baseline) — excluded from Step 2 trend calc and excluded from Step 2 hash
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

  const baseBundle = {
    user_id: userId,
    bundle_day_key: bundleDayKey,
    window_days,

    // Step 2 output (locked shape)
    daily_snapshot_trends,

    // Returning snapshots is allowed; authority is still the table; no mutation occurs
    daily_snapshots: snapshots,

    // v1 baseline anchors (explicitly excluded from Step 2 trend calc + hash)
    latest_anchors: {
      conneqt,
      tanita,
      grip,
      rmr,
    },

    // Placeholders (unchanged)
    derived_metrics: {},
    confidence: {},
    flags: [],
    provenance_summary: {},
  };

  // Step 2 canonical hash payload (anchors excluded)
  const hashPayload = {
    bundle_day_key: bundleDayKey,
    window_days,
    daily_snapshots: snapshots.map((s) => ({
      id: s.id,
      day_key: s.day_key,

      // Step 2 metrics in-scope (nullable, vendor-agnostic)
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
