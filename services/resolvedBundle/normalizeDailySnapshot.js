// services/resolvedBundle/normalizeDailySnapshot.js

function minutesToHoursOrNull(mins) {
  const n = Number(mins);
  return Number.isFinite(n) ? n / 60 : null;
}

function toDayKeyUTC(value) {
  if (!value) return null;

  // Already YYYY-MM-DD
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  // ISO-like string -> take first 10 chars (YYYY-MM-DD)
  if (typeof value === "string" && value.length >= 10) return value.slice(0, 10);

  // Date object
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const yy = value.getUTCFullYear();
    const mm = String(value.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(value.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  // Fallback: Date.parse
  const t = Date.parse(value);
  if (Number.isFinite(t)) {
    const dt = new Date(t);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  return null;
}

/**
 * Step 1.5 — Normalization (LOCKED)
 * Purpose:
 * - Normalize DB columns -> canonical in-memory fields
 * - Derive day_key (UTC YYYY-MM-DD)
 * - Derive sleep_duration (hours)
 * - Canonical aliases (body_fat_pct, etc.)
 * No DB writes.
 *
 * Rule:
 * - All downstream logic consumes normalized snapshots only.
 */
function normalizeDailySnapshot(row) {
  if (!row) return null;

  const day_key = toDayKeyUTC(row.snapshot_date ?? row.day_key);

  // Preserve original row, but override/define canonical fields explicitly.
  return {
    ...row,

    // Canonical day key used throughout the backend pipeline
    day_key,

    // --- Canonical wearable metrics used by Step 2 (nullable if absent) ---
    resting_hr: row.resting_hr ?? row.resting_heart_rate ?? null,
    hrv: row.hrv ?? null,

    // Sleep: derive hours from minutes when present
    sleep_duration: minutesToHoursOrNull(
      row.sleep_total_minutes ?? row.sleep_duration_minutes ?? row.sleep_minutes
    ),
    sleep_efficiency: row.sleep_efficiency ?? null,

    // Activity
    steps: row.steps ?? null,
    activity_minutes:
      row.activity_minutes ??
      row.active_minutes ??
      row.moderate_activity_minutes ??
      null,

    // Vitals
    respiratory_rate: row.respiratory_rate ?? null,
    skin_temp_delta: row.skin_temp_delta ?? row.skin_temperature_delta ?? null,
    blood_oxygen: row.blood_oxygen ?? row.spo2 ?? null,

    // Optional wearable body comp fields (may be absent depending on vendor)
    weight_kg: row.weight_kg ?? row.body_weight_kg ?? null,

    // Canonical alias
    body_fat_pct: row.body_fat_percent ?? row.body_fat_pct ?? null,

    // Optional wearable BP if present in schema
    bp_systolic: row.bp_systolic ?? row.blood_pressure_systolic ?? null,
    bp_diastolic: row.bp_diastolic ?? row.blood_pressure_diastolic ?? null,
  };
}

module.exports = { normalizeDailySnapshot };
