// services/resolvedBundle/buildResolvedBundle.js
const crypto = require("crypto");

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
 * Returns the canonical ResolvedBundle shape with deterministic bundle_hash.
 *
 * v1: includes latest_anchors (conneqt, tanita, grip, rmr) using "latest wins".
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
      throw new Error(`latestFrom ${table} failed: ${error.message || error.code}`);
    }
    return data?.[0] || null;
  }

  // Keep selects aligned with /anchors/latest, plus raw_json
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
    window_days: Number(windowDays) || 28,

    daily_snapshot_trends: {},

    latest_anchors: {
      conneqt,
      tanita,
      grip,
      rmr,
    },

    derived_metrics: {},
    confidence: {},
    flags: [],
    provenance_summary: {},
  };

  const canonical = stableStringify(baseBundle);
  const bundle_hash = sha256Hex(canonical);

  return { ...baseBundle, bundle_hash };
}

module.exports = { buildResolvedBundle };
