// server.js
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
require("dotenv").config();
const { sendPush } = require("./apns");

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json({ limit: "1mb" }));

// 👇 static file hosting for dashboard build
app.use(express.static(path.join(__dirname, "public")));
app.use("/dashboard", express.static(path.join(__dirname, "public", "dashboard")));

// SPA fallback for any /dashboard/* route
app.get("/dashboard/*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard", "index.html"));
});

// --- Shared helpers / regex ---
const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// --- Date helpers (UTC-stable) ---
function toIsoOrNull(x) {
  try {
    const d = x ? new Date(x) : null;
    if (!d || isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}
function dayKeyUtc(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// --- Supabase client ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// --- Health routes ---
app.get("/", (_req, res) => res.send("Vitaliage Push API ✅"));
app.get("/ping", (_req, res) => res.json({ ok: true }));

// --- DB connectivity check ---
app.get("/db-check", async (_req, res) => {
  try {
    const { data, error } = await supabase.from("devices").select("*").limit(1);
    if (error) throw error;
    res.json({
      connected: true,
      rows_found: data?.length ?? 0,
      sample_row: data?.[0] || null,
    });
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

// --- UPSERT device token ---
app.post("/devices", async (req, res) => {
  const { userId, platform = "ios", token } = req.body || {};
  if (!token) return res.status(400).json({ error: "Missing token" });

  const cleanUserId = uuidRegex.test(userId || "") ? userId : null;

  try {
    const { error } = await supabase
      .from("devices")
      .upsert([{ user_id: cleanUserId, platform, token }], {
        onConflict: "token",
        returning: "minimal",
      });

    if (error) {
      return res.status(500).json({
        error: "Database upsert failed",
        detail: error.message || error.hint || error.code,
      });
    }

    // Best-effort last_seen update (ignore errors)
    try {
      await supabase
        .from("devices")
        .update({ last_seen: new Date().toISOString() })
        .eq("token", token);
    } catch (_) {}

    const { data: rows } = await supabase
      .from("devices")
      .select("id,user_id,platform,token,active,last_seen,created_at")
      .eq("token", token)
      .limit(1);

    return res.json({
      message: "Device token stored",
      device: rows?.[0] || null,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ error: "Unexpected server error", detail: e.message });
  }
});

// --- Push handler used by /push, /api/push, /push/send ---
async function handleSend(req, res) {
  const {
    token,
    title,
    body,
    data,
    silent = false,
    collapseId,
    priority,
    pushType, // optional: 'alert' | 'background'
  } = req.body || {};

  if (!token) return res.status(400).json({ ok: false, error: "Missing 'token'" });

  const effectivePushType = pushType || (silent ? "background" : "alert");

  try {
    const result = await sendPush(
      token,
      { title, body, data },
      { pushType: effectivePushType, priority, collapseId }
    );

    const ok = Number(result.status) === 200;
    return res.status(ok ? 200 : result.status || 400).json({
      ok,
      status: result.status,
      apns: result.body || null,
      headers: result.headers || null,
    });
  } catch (err) {
    console.error("APNs send error:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}

app.post("/push", handleSend);
app.post("/api/push", handleSend);
app.post("/push/send", handleSend);

// --- NEW: push to the most recent active device ---
app.post("/push-latest", async (req, res) => {
  try {
    const {
      userId,
      title = "Test from /push-latest",
      body = "This went to the most recent device",
      data,
      silent = false,
      collapseId,
      priority,
      pushType,
    } = req.body || {};

    // Build base query: only active devices
    let query = supabase
      .from("devices")
      .select("id,user_id,platform,token,active,last_seen,created_at")
      .eq("active", true);

    // If a valid userId is provided, filter by that user
    if (userId && uuidRegex.test(userId)) {
      query = query.eq("user_id", userId);
    }

    // Order by most recently seen
    query = query.order("last_seen", { ascending: false }).limit(1);

    const { data: rows, error } = await query;

    if (error) {
      console.error("Supabase error in /push-latest:", error);
      return res
        .status(500)
        .json({ ok: false, error: "Supabase query failed", detail: error.message });
    }

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "No active devices found",
        detail: userId ? "No active devices for this user" : "No devices in table",
      });
    }

    const device = rows[0];
    const effectivePushType = pushType || (silent ? "background" : "alert");

    const result = await sendPush(
      device.token,
      { title, body, data },
      { pushType: effectivePushType, priority, collapseId }
    );

    const ok = Number(result.status) === 200;

    return res.status(ok ? 200 : result.status || 400).json({
      ok,
      status: result.status,
      device: {
        id: device.id,
        user_id: device.user_id,
        platform: device.platform,
        token: device.token,
        active: device.active,
        last_seen: device.last_seen,
        created_at: device.created_at,
      },
      apns: result.body || null,
      headers: result.headers || null,
    });
  } catch (err) {
    console.error("Error in /push-latest:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Internal server error", detail: err.message });
  }
});

// =======================================================
// OFFICE MEASUREMENTS (Staff entry)
// Table: office_measurements (you already created)
// =======================================================
app.post("/office/measurements", async (req, res) => {
  try {
    const payload = req.body || {};
    const {
      userId,
      measuredAt,
      bpSystolic,
      bpDiastolic,
      weightKg,
      bodyFatPct,
      device,
      operator,
      conditions,
      quality, // "high" | "medium" | "low"
    } = payload;

    const cleanUserId = uuidRegex.test(userId || "") ? userId : null;

    const tsIso = toIsoOrNull(measuredAt) || new Date().toISOString();
    const dk = dayKeyUtc(tsIso);
    if (!dk) return res.status(400).json({ ok: false, error: "invalid_measuredAt" });

    const hasAny =
      bpSystolic != null ||
      bpDiastolic != null ||
      weightKg != null ||
      bodyFatPct != null;

    if (!hasAny) {
      return res.status(400).json({
        ok: false,
        error: "empty_measurement",
        message: "Provide at least one of BP, weightKg, bodyFatPct.",
      });
    }

    // BP should come as a pair if present
    if (
      (bpSystolic != null && bpDiastolic == null) ||
      (bpDiastolic != null && bpSystolic == null)
    ) {
      return res.status(400).json({
        ok: false,
        error: "bp_requires_pair",
        message: "Provide both bpSystolic and bpDiastolic together.",
      });
    }

    const row = {
      user_id: cleanUserId,
      measured_at: tsIso,
      day_key: dk,

      bp_systolic: bpSystolic ?? null,
      bp_diastolic: bpDiastolic ?? null,
      weight_kg: weightKg ?? null,
      body_fat_pct: bodyFatPct ?? null,

      source: "OFFICE",
      device: device ?? null,
      operator: operator ?? null,
      conditions: conditions ?? null,
      quality: quality ?? null,

      raw_json: payload,
    };

    const { data, error } = await supabase
      .from("office_measurements")
      .insert(row)
      .select("id,user_id,measured_at,day_key,bp_systolic,bp_diastolic,quality,device,operator")
      .limit(1);

    if (error) {
      console.error("❌ Supabase insert error in /office/measurements:", error);
      return res.status(500).json({
        ok: false,
        error: "db_insert_failed",
        detail: error.message || error.code,
      });
    }

    return res.status(200).json({ ok: true, measurement: data?.[0] || null });
  } catch (err) {
    console.error("Error in POST /office/measurements:", err);
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err.message });
  }
});

// =======================================================
// CONNEQT Pulse (Staff entry / in-clinic anchor)
// Table: conneqt_assessments (you must create)
// Field names match the machine display list.
// =======================================================
app.post("/office/conneqt", async (req, res) => {
  try {
    const payload = req.body || {};
    const {
      userId,
      measuredAt,

      device = "CONNEQT Pulse",
      operator,
      conditions,
      quality, // "high" | "medium" | "low"

      // Machine fields (match display)
      brachialSystolic,
      brachialDiastolic,

      centralSystolic,
      centralDiastolic,

      heartRate,

      augmentationIndex, // AIx
      augmentationPressure, // AP
      pulsePressureAmplification, // PPA
      sevr,
      centralPulsePressure, // CPP
      arterialAge,

      reportPdfUrl,
    } = payload;

    const cleanUserId = uuidRegex.test(userId || "") ? userId : null;

    const tsIso = toIsoOrNull(measuredAt) || new Date().toISOString();
    const dk = dayKeyUtc(tsIso);
    if (!dk) return res.status(400).json({ ok: false, error: "invalid_measuredAt" });

    const hasAny =
      brachialSystolic != null ||
      centralSystolic != null ||
      heartRate != null ||
      augmentationIndex != null ||
      augmentationPressure != null ||
      pulsePressureAmplification != null ||
      sevr != null ||
      centralPulsePressure != null ||
      arterialAge != null;

    if (!hasAny) {
      return res.status(400).json({
        ok: false,
        error: "empty_conneqt_payload",
        message: "Provide at least one CONNEQT measurement value.",
      });
    }

    // Pair checks for BP fields
    if (
      (brachialSystolic != null && brachialDiastolic == null) ||
      (brachialDiastolic != null && brachialSystolic == null)
    ) {
      return res.status(400).json({
        ok: false,
        error: "brachial_bp_requires_pair",
        message: "Provide both brachialSystolic and brachialDiastolic together.",
      });
    }
    if (
      (centralSystolic != null && centralDiastolic == null) ||
      (centralDiastolic != null && centralSystolic == null)
    ) {
      return res.status(400).json({
        ok: false,
        error: "central_bp_requires_pair",
        message: "Provide both centralSystolic and centralDiastolic together.",
      });
    }

    const row = {
      user_id: cleanUserId,
      measured_at: tsIso,
      day_key: dk,

      source: "CONNEQT",
      device: device ?? null,
      operator: operator ?? null,
      conditions: conditions ?? null,
      quality: quality ?? null,

      brachial_systolic: brachialSystolic ?? null,
      brachial_diastolic: brachialDiastolic ?? null,

      central_systolic: centralSystolic ?? null,
      central_diastolic: centralDiastolic ?? null,

      heart_rate: heartRate ?? null,

      augmentation_index: augmentationIndex ?? null,
      augmentation_pressure: augmentationPressure ?? null,
      pulse_pressure_amplification: pulsePressureAmplification ?? null,
      sevr: sevr ?? null,
      central_pulse_pressure: centralPulsePressure ?? null,
      arterial_age: arterialAge ?? null,

      report_pdf_url: reportPdfUrl ?? null,
      raw_json: payload,
    };

    const { data, error } = await supabase
      .from("conneqt_assessments")
      .insert(row)
      .select("id,user_id,measured_at,day_key,source,quality")
      .limit(1);

    if (error) {
      console.error("❌ Supabase insert error in /office/conneqt:", error);
      return res.status(500).json({
        ok: false,
        error: "db_insert_failed",
        detail: error.message || error.code,
      });
    }

    return res.status(200).json({ ok: true, assessment: data?.[0] || null });
  } catch (err) {
    console.error("Error in POST /office/conneqt:", err);
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err.message });
  }
});
// =======================================================
// Tanita MC-580 (Staff entry / in-clinic anchor)
// Table: tanita_assessments
// =======================================================
app.post("/office/tanita", async (req, res) => {
  try {
    const payload = req.body || {};
    const {
      userId,
      measuredAt,

      device = "Tanita MC-580",
      operator,
      conditions,
      quality, // "high" | "medium" | "low"

      // common fields
      weightKg,
      bodyFatPct,
      fatMassKg,
      fatFreeMassKg,
      muscleMassKg,
      tbwPct,
      tbwKg,
      visceralFatRating,
      bmrKcal,
      metabolicAge,
    } = payload;

    const cleanUserId = uuidRegex.test(userId || "") ? userId : null;

    const tsIso = toIsoOrNull(measuredAt) || new Date().toISOString();
    const dk = dayKeyUtc(tsIso);
    if (!dk) return res.status(400).json({ ok: false, error: "invalid_measuredAt" });

    const hasAny =
      weightKg != null ||
      bodyFatPct != null ||
      fatMassKg != null ||
      fatFreeMassKg != null ||
      muscleMassKg != null ||
      tbwPct != null ||
      tbwKg != null ||
      visceralFatRating != null ||
      bmrKcal != null ||
      metabolicAge != null;

    if (!hasAny) {
      return res.status(400).json({
        ok: false,
        error: "empty_tanita_payload",
        message: "Provide at least one Tanita measurement value.",
      });
    }

    const row = {
      user_id: cleanUserId,
      measured_at: tsIso,
      day_key: dk,

      source: "TANITA",
      device: device ?? null,
      operator: operator ?? null,
      conditions: conditions ?? null,
      quality: quality ?? null,

      weight_kg: weightKg ?? null,
      body_fat_pct: bodyFatPct ?? null,
      fat_mass_kg: fatMassKg ?? null,
      fat_free_mass_kg: fatFreeMassKg ?? null,
      muscle_mass_kg: muscleMassKg ?? null,
      tbw_pct: tbwPct ?? null,
      tbw_kg: tbwKg ?? null,
      visceral_fat_rating: visceralFatRating ?? null,
      bmr_kcal: bmrKcal ?? null,
      metabolic_age: metabolicAge ?? null,

      raw_json: payload,
    };

    const { data, error } = await supabase
      .from("tanita_assessments")
      .insert(row)
      .select("id,user_id,measured_at,day_key,source,quality")
      .limit(1);

    if (error) {
      console.error("❌ Supabase insert error in /office/tanita:", error);
      return res.status(500).json({
        ok: false,
        error: "db_insert_failed",
        detail: error.message || error.code,
      });
    }

    return res.status(200).json({ ok: true, assessment: data?.[0] || null });
  } catch (err) {
    console.error("Error in POST /office/tanita:", err);
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err.message });
  }
});
// =======================================================
// Jamar Grip Strength (Staff entry / in-clinic anchor)
// Table: grip_strength_assessments
// =======================================================
app.post("/office/grip", async (req, res) => {
  try {
    const payload = req.body || {};
    const {
      userId,
      measuredAt,

      device = "Jamar",
      operator,
      conditions,
      quality, // "high" | "medium" | "low"

      unit = "kgf", // "kgf" | "lbs"
      leftBest,
      rightBest,
      leftAttempts,  // optional array
      rightAttempts, // optional array
      notes,
    } = payload;

    const cleanUserId = uuidRegex.test(userId || "") ? userId : null;
    const tsIso = toIsoOrNull(measuredAt) || new Date().toISOString();
    const dk = dayKeyUtc(tsIso);
    if (!dk) return res.status(400).json({ ok: false, error: "invalid_measuredAt" });

    const hasAny = leftBest != null || rightBest != null || (Array.isArray(leftAttempts) && leftAttempts.length) || (Array.isArray(rightAttempts) && rightAttempts.length);
    if (!hasAny) {
      return res.status(400).json({
        ok: false,
        error: "empty_grip_payload",
        message: "Provide at least one grip value (leftBest or rightBest).",
      });
    }

    const row = {
      user_id: cleanUserId,
      measured_at: tsIso,
      day_key: dk,

      source: "JAMAR",
      device: device ?? null,
      operator: operator ?? null,
      conditions: conditions ?? null,
      quality: quality ?? null,

      unit,
      left_best: leftBest ?? null,
      right_best: rightBest ?? null,
      left_attempts: leftAttempts ?? null,
      right_attempts: rightAttempts ?? null,

      notes: notes ?? null,
      raw_json: payload,
    };

    const { data, error } = await supabase
      .from("grip_strength_assessments")
      .insert(row)
      .select("id,user_id,measured_at,day_key,source,quality")
      .limit(1);

    if (error) {
      console.error("❌ Supabase insert error in /office/grip:", error);
      return res.status(500).json({ ok: false, error: "db_insert_failed", detail: error.message || error.code });
    }

    return res.status(200).json({ ok: true, assessment: data?.[0] || null });
  } catch (err) {
    console.error("Error in POST /office/grip:", err);
    return res.status(500).json({ ok: false, error: "internal_error", detail: err.message });
  }
});
// =======================================================
// KORR ReeVue RMR (Staff entry / in-clinic anchor)
// Table: rmr_assessments
// =======================================================
app.post("/office/rmr", async (req, res) => {
  try {
    const payload = req.body || {};
    const {
      userId,
      measuredAt,

      device = "KORR ReeVue",
      operator,
      conditions,
      quality, // "high" | "medium" | "low"

      rmrKcalDay,
      vo2MlMin,
      vco2MlMin,
      rer,
      steadyStateMinutes,

      protocol,
      notes,
    } = payload;

    const cleanUserId = uuidRegex.test(userId || "") ? userId : null;
    const tsIso = toIsoOrNull(measuredAt) || new Date().toISOString();
    const dk = dayKeyUtc(tsIso);
    if (!dk) return res.status(400).json({ ok: false, error: "invalid_measuredAt" });

    const hasAny = rmrKcalDay != null || vo2MlMin != null || vco2MlMin != null || rer != null;
    if (!hasAny) {
      return res.status(400).json({
        ok: false,
        error: "empty_rmr_payload",
        message: "Provide at least one RMR value (rmrKcalDay recommended).",
      });
    }

    const row = {
      user_id: cleanUserId,
      measured_at: tsIso,
      day_key: dk,

      source: "KORR_REEVUE",
      device: device ?? null,
      operator: operator ?? null,
      conditions: conditions ?? null,
      quality: quality ?? null,

      rmr_kcal_day: rmrKcalDay ?? null,
      vo2_ml_min: vo2MlMin ?? null,
      vco2_ml_min: vco2MlMin ?? null,
      rer: rer ?? null,
      steady_state_minutes: steadyStateMinutes ?? null,

      protocol: protocol ?? null,
      notes: notes ?? null,
      raw_json: payload,
    };

    const { data, error } = await supabase
      .from("rmr_assessments")
      .insert(row)
      .select("id,user_id,measured_at,day_key,source,quality")
      .limit(1);

    if (error) {
      console.error("❌ Supabase insert error in /office/rmr:", error);
      return res.status(500).json({ ok: false, error: "db_insert_failed", detail: error.message || error.code });
    }

    return res.status(200).json({ ok: true, assessment: data?.[0] || null });
  } catch (err) {
    console.error("Error in POST /office/rmr:", err);
    return res.status(500).json({ ok: false, error: "internal_error", detail: err.message });
  }
});

// --- receive daily health snapshot from iOS app and store in Supabase ---
app.post("/snapshot", async (req, res) => {
  try {
    const snapshot = req.body || {};

    console.log("📬 Received /snapshot payload:");
    console.log(JSON.stringify(snapshot, null, 2));

    const {
      userId,
      id: externalId,
      date,
      steps,
      restingHR,
      vo2Max,
      hrv,
      respiratoryRate,
      activityEnergy,
      standHours,
      bpSystolic,
      bpDiastolic,
      glucoseMgDl,
      sleep,
    } = snapshot;

    const cleanUserId = uuidRegex.test(userId || "") ? userId : null;

    const row = {
      user_id: cleanUserId,
      external_id: externalId || null,
      snapshot_date: date || new Date().toISOString(),

      steps,
      resting_hr: restingHR,
      vo2_max: vo2Max,

      hrv,
      respiratory_rate: respiratoryRate,
      activity_energy: activityEnergy,
      stand_hours: standHours,
      bp_systolic: bpSystolic,
      bp_diastolic: bpDiastolic,
      glucose_mg_dl: glucoseMgDl,

      sleep_total_minutes: sleep?.totalMinutes ?? null,
      sleep_goal_minutes: sleep?.goalMinutes ?? null,
      sleep_met_goal: typeof sleep?.metGoal === "boolean" ? sleep.metGoal : null,

      raw_json: snapshot,
    };

    const { error } = await supabase.from("daily_snapshots").insert(row);

    if (error) {
      console.error("❌ Supabase insert error in /snapshot:", error);
      return res.status(500).json({
        ok: false,
        error: "db_insert_failed",
        detail: error.message || error.code,
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error in /snapshot:", err);
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err.message });
  }
});

// =======================================================
// fetch daily snapshots + precedence-aware BP merge
// precedence (same day): OFFICE > CONNEQT(brachial) > WEARABLE
// =======================================================
app.get("/daily-snapshots", async (req, res) => {
  try {
    const { userId, from, to, limit } = req.query;
    const cleanUserId = userId && uuidRegex.test(userId) ? userId : null;

    // 1) load wearable snapshots
    let query = supabase
      .from("daily_snapshots")
      .select(
        `
        id,
        user_id,
        external_id,
        snapshot_date,
        steps,
        resting_hr,
        vo2_max,
        hrv,
        respiratory_rate,
        activity_energy,
        stand_hours,
        bp_systolic,
        bp_diastolic,
        glucose_mg_dl,
        sleep_total_minutes,
        sleep_goal_minutes,
        sleep_met_goal,
        raw_json
      `
      )
      .order("snapshot_date", { ascending: false });

    if (cleanUserId) query = query.eq("user_id", cleanUserId);
    if (from) query = query.gte("snapshot_date", from);
    if (to) query = query.lte("snapshot_date", to);

    const effectiveLimit = Number(limit) > 0 ? Number(limit) : 7;
    query = query.limit(effectiveLimit);

    const { data, error } = await query;

    if (error) {
      console.error("❌ Supabase error in GET /daily-snapshots:", error);
      return res.status(500).json({
        ok: false,
        error: "db_query_failed",
        detail: error.message || error.code,
      });
    }

    const wearableRows = data || [];

    // 2) determine range for overlay queries
    let rangeFrom = from;
    let rangeTo = to;

    if (!rangeFrom || !rangeTo) {
      const dates = wearableRows
        .map((r) => toIsoOrNull(r.snapshot_date))
        .filter(Boolean)
        .sort(); // asc
      if (!rangeFrom && dates.length) rangeFrom = dates[0];
      if (!rangeTo && dates.length) rangeTo = dates[dates.length - 1];
    }

    // 3) load OFFICE measurements in range (safe)
    let officeByDay = new Map();
    try {
      let officeQuery = supabase
        .from("office_measurements")
        .select("measured_at,day_key,bp_systolic,bp_diastolic,quality")
        .order("measured_at", { ascending: false })
        .limit(500);

      if (cleanUserId) officeQuery = officeQuery.eq("user_id", cleanUserId);
      if (rangeFrom) officeQuery = officeQuery.gte("measured_at", rangeFrom);
      if (rangeTo) officeQuery = officeQuery.lte("measured_at", rangeTo);

      const { data: officeRows, error: officeErr } = await officeQuery;
      if (!officeErr && officeRows?.length) {
        for (const om of officeRows) {
          const dk = om.day_key || dayKeyUtc(om.measured_at);
          if (!dk) continue;
          if (!officeByDay.has(dk) && om.bp_systolic != null && om.bp_diastolic != null) {
            officeByDay.set(dk, om);
          }
        }
      } else if (officeErr) {
        console.warn("⚠️ office_measurements query failed:", officeErr.message || officeErr.code);
      }
    } catch (e) {
      console.warn("⚠️ office_measurements overlay skipped:", e?.message || String(e));
    }

    // 4) load CONNEQT assessments in range (safe)
    let conneqtByDay = new Map();
    try {
      let cq = supabase
        .from("conneqt_assessments")
        .select("measured_at,day_key,brachial_systolic,brachial_diastolic,quality")
        .order("measured_at", { ascending: false })
        .limit(500);

      if (cleanUserId) cq = cq.eq("user_id", cleanUserId);
      if (rangeFrom) cq = cq.gte("measured_at", rangeFrom);
      if (rangeTo) cq = cq.lte("measured_at", rangeTo);

      const { data: cRows, error: cErr } = await cq;
      if (!cErr && cRows?.length) {
        for (const r of cRows) {
          const dk = r.day_key || dayKeyUtc(r.measured_at);
          if (!dk) continue;
          if (
            !conneqtByDay.has(dk) &&
            r.brachial_systolic != null &&
            r.brachial_diastolic != null
          ) {
            conneqtByDay.set(dk, r);
          }
        }
      } else if (cErr) {
        console.warn("⚠️ conneqt_assessments query failed (table may not exist yet):", cErr.message || cErr.code);
      }
    } catch (e) {
      console.warn("⚠️ conneqt_assessments overlay skipped:", e?.message || String(e));
    }

    // 5) map + merge BP precedence into returned DTO
    const snapshots = wearableRows.map((row) => {
      const sleep =
        row.sleep_total_minutes != null ||
        row.sleep_goal_minutes != null ||
        row.sleep_met_goal != null
          ? {
              totalMinutes: row.sleep_total_minutes,
              goalMinutes: row.sleep_goal_minutes,
              metGoal: row.sleep_met_goal,
            }
          : null;

      const dto = {
        id: row.external_id || row.id,
        userId: row.user_id,
        date: row.snapshot_date,
        steps: row.steps,
        restingHR: row.resting_hr,
        vo2Max: row.vo2_max,
        hrv: row.hrv,
        respiratoryRate: row.respiratory_rate,
        activityEnergy: row.activity_energy,
        standHours: row.stand_hours,
        bpSystolic: row.bp_systolic,
        bpDiastolic: row.bp_diastolic,
        glucoseMgDl: row.glucose_mg_dl,
        sleep,
        raw: row.raw_json,
      };

      const dk = dayKeyUtc(row.snapshot_date);
      const office = dk ? officeByDay.get(dk) : null;
      const conneqt = dk ? conneqtByDay.get(dk) : null;

      // precedence: OFFICE > CONNEQT(brachial) > wearable
      if (office) {
        dto.bpSystolic = office.bp_systolic;
        dto.bpDiastolic = office.bp_diastolic;

        dto.raw = dto.raw || {};
        dto.raw._provenance = dto.raw._provenance || {};
        dto.raw._provenance.bp = { source: "OFFICE", measuredAt: office.measured_at, quality: office.quality ?? null };
      } else if (conneqt) {
        dto.bpSystolic = conneqt.brachial_systolic;
        dto.bpDiastolic = conneqt.brachial_diastolic;

        dto.raw = dto.raw || {};
        dto.raw._provenance = dto.raw._provenance || {};
        dto.raw._provenance.bp = { source: "CONNEQT", measuredAt: conneqt.measured_at, quality: conneqt.quality ?? null };
      }

      return dto;
    });

    return res.json({ ok: true, snapshots });
  } catch (err) {
    console.error("Error in GET /daily-snapshots:", err);
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err.message });
  }
});

// --- metric summary endpoint (bp now honors precedence overlay) ---
app.get("/metric-summary", async (req, res) => {
  try {
    const metric = String(req.query.metric || "").trim();
    const windowDays = Math.min(
      Math.max(parseInt(req.query.windowDays || "7", 10) || 7, 1),
      30
    );

    if (!metric) {
      return res.status(400).json({
        ok: false,
        error: "invalid_request",
        message: "Missing 'metric' query parameter.",
      });
    }

    // Map external metric keys → daily_snapshots columns/fields
    const metricConfig = {
      steps: { field: "steps", unit: "steps" },
      vo2max: { field: "vo2_max", unit: "ml/kg/min" },
      hrv: { field: "hrv", unit: "ms" },
      resting_hr: { field: "resting_hr", unit: "bpm" },
      sleep: { getter: (row) => row.sleep_total_minutes ?? null, unit: "minutes" },
      glucose: { field: "glucose_mg_dl", unit: "mg/dL" },
      bp: { getter: (row) => row.bp_systolic ?? null, unit: "mmHg" },
      rr: { field: "respiratory_rate", unit: "breaths/min" },
      adherence: { getter: (row) => (row.raw_json && row.raw_json.adherence) ?? null, unit: "score" },
      readiness: { getter: (row) => (row.raw_json && row.raw_json.readiness) ?? null, unit: "score" },
    };

    const cfg = metricConfig[metric];
    if (!cfg) {
      return res.status(400).json({
        ok: false,
        error: "unsupported_metric",
        message: `Unsupported metric '${metric}'.`,
      });
    }

    // Date window based on snapshot_date (UTC)
    const now = new Date();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
    const start = new Date(end.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000);

    const { data, error } = await supabase
      .from("daily_snapshots")
      .select("*")
      .gte("snapshot_date", start.toISOString())
      .lte("snapshot_date", end.toISOString())
      .order("snapshot_date", { ascending: true });

    if (error) {
      console.error("Error querying daily_snapshots for /metric-summary:", error);
      return res.status(500).json({
        ok: false,
        error: "server_error",
        message: "Failed to load snapshots for metric summary.",
      });
    }

    const rows = data || [];

    // For bp: overlay OFFICE > CONNEQT(brachial) > wearable by day
    let officeByDay = new Map();
    let conneqtByDay = new Map();

    if (metric === "bp") {
      try {
        const { data: oRows, error: oErr } = await supabase
          .from("office_measurements")
          .select("measured_at,day_key,bp_systolic,bp_diastolic")
          .gte("measured_at", start.toISOString())
          .lte("measured_at", end.toISOString())
          .order("measured_at", { ascending: false })
          .limit(500);

        if (!oErr && oRows?.length) {
          for (const r of oRows) {
            const dk = r.day_key || dayKeyUtc(r.measured_at);
            if (!dk) continue;
            if (!officeByDay.has(dk) && r.bp_systolic != null && r.bp_diastolic != null) {
              officeByDay.set(dk, r);
            }
          }
        }
      } catch (_) {}

      try {
        const { data: cRows, error: cErr } = await supabase
          .from("conneqt_assessments")
          .select("measured_at,day_key,brachial_systolic,brachial_diastolic")
          .gte("measured_at", start.toISOString())
          .lte("measured_at", end.toISOString())
          .order("measured_at", { ascending: false })
          .limit(500);

        if (!cErr && cRows?.length) {
          for (const r of cRows) {
            const dk = r.day_key || dayKeyUtc(r.measured_at);
            if (!dk) continue;
            if (!conneqtByDay.has(dk) && r.brachial_systolic != null && r.brachial_diastolic != null) {
              conneqtByDay.set(dk, r);
            }
          }
        }
      } catch (_) {}
    }

    const series = rows
      .map((row) => {
        const d = new Date(row.snapshot_date || row.date);
        const dateStr = d.toISOString().slice(0, 10);

        let value = null;

        if (metric === "bp") {
          const office = officeByDay.get(dateStr);
          const conneqt = conneqtByDay.get(dateStr);

          if (office?.bp_systolic != null) value = office.bp_systolic;
          else if (conneqt?.brachial_systolic != null) value = conneqt.brachial_systolic;
          else value = row.bp_systolic ?? null;
        } else if (typeof cfg.getter === "function") {
          value = cfg.getter(row);
        } else if (cfg.field) {
          value = row[cfg.field];
        }

        if (value == null) return null;

        return { date: dateStr, value: Number(value) };
      })
      .filter(Boolean);

    // Basic trend detection
    let trend = null;
    if (series.length >= 2) {
      const first = series[0].value;
      const last = series[series.length - 1].value;
      if (last > first * 1.05) trend = "improving";
      else if (last < first * 0.95) trend = "worsening";
      else trend = "stable";
    }

    return res.json({
      ok: true,
      metric,
      windowDays,
      series,
      meta: {
        unit: cfg.unit,
        primarySource: metric === "bp" ? "OFFICE>CONNEQT>WEARABLE" : null,
        sources: metric === "bp" ? ["OFFICE", "CONNEQT", "WEARABLE"] : [],
        trend,
      },
    });
  } catch (err) {
    console.error("Unexpected error in /metric-summary:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: "Unexpected error in metric-summary.",
    });
  }
});
// =======================================================
// Anchors: get latest in-clinic anchor records (read-only)
// GET /anchors/latest?userId=<uuid optional>
// Returns latest: conneqt, tanita, grip, rmr
// =======================================================
app.get("/anchors/latest", async (req, res) => {
  try {
    const { userId } = req.query;
    const cleanUserId = userId && uuidRegex.test(String(userId)) ? String(userId) : null;

    async function latestFrom(table, selectCols) {
      let q = supabase.from(table).select(selectCols).order("measured_at", { ascending: false }).limit(1);
      if (cleanUserId) q = q.eq("user_id", cleanUserId);
      const { data, error } = await q;
      if (error) return { ok: false, error: error.message || error.code, row: null };
      return { ok: true, row: data?.[0] || null };
    }

    // Each query is independent; missing tables won't break the whole response.
    const [conneqt, tanita, grip, rmr] = await Promise.all([
      latestFrom(
        "conneqt_assessments",
        "id,user_id,measured_at,day_key,quality,device,operator,conditions,brachial_systolic,brachial_diastolic,central_systolic,central_diastolic,heart_rate,augmentation_index,augmentation_pressure,pulse_pressure_amplification,sevr,central_pulse_pressure,arterial_age,report_pdf_url"
      ),
      latestFrom(
        "tanita_assessments",
        "id,user_id,measured_at,day_key,quality,device,operator,conditions,weight_kg,body_fat_pct,fat_mass_kg,fat_free_mass_kg,muscle_mass_kg,tbw_pct,tbw_kg,visceral_fat_rating,bmr_kcal,metabolic_age"
      ),
      latestFrom(
        "grip_strength_assessments",
        "id,user_id,measured_at,day_key,quality,device,operator,conditions,unit,left_best,right_best,notes"
      ),
      latestFrom(
        "rmr_assessments",
        "id,user_id,measured_at,day_key,quality,device,operator,conditions,rmr_kcal_day,vo2_ml_min,vco2_ml_min,rer,steady_state_minutes,protocol,notes"
      ),
    ]);

    // If a table doesn't exist yet, Supabase often returns an error.
    // We will still return ok:true overall, but include per-anchor status.
    return res.json({
      ok: true,
      filter: { userId: cleanUserId }, // null means "global latest"
      latest: {
        conneqt: conneqt.row,
        tanita: tanita.row,
        grip: grip.row,
        rmr: rmr.row,
      },
      status: {
        conneqt: conneqt.ok ? "ok" : "error",
        tanita: tanita.ok ? "ok" : "error",
        grip: grip.ok ? "ok" : "error",
        rmr: rmr.ok ? "ok" : "error",
      },
      errors: {
        conneqt: conneqt.ok ? null : conneqt.error,
        tanita: tanita.ok ? null : tanita.error,
        grip: grip.ok ? null : grip.error,
        rmr: rmr.ok ? null : rmr.error,
      },
    });
  } catch (err) {
    console.error("Error in GET /anchors/latest:", err);
    return res.status(500).json({ ok: false, error: "internal_error", detail: err.message });
  }
});

// --- Debug: list all registered routes ---
function listRoutes() {
  const out = [];
  app._router?.stack?.forEach((m) => {
    if (m.route && m.route.path) {
      out.push({
        methods: Object.keys(m.route.methods).map((x) => x.toUpperCase()),
        path: m.route.path,
      });
    }
  });
  return out;
}

app.get("/__routes", (_req, res) => res.json(listRoutes()));

// --- Start server ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
