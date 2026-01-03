// server.js
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
require("dotenv").config();
const { sendPush } = require("./apns");

const { buildResolvedBundle } = require("./services/resolvedBundle/buildResolvedBundle");

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json({ limit: "1mb" }));

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

// expand overlay windows to whole UTC days
function startOfDayUtc(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (isNaN(d.getTime())) return null;
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0)
  ).toISOString();
}
function endOfDayUtc(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (isNaN(d.getTime())) return null;
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59)
  ).toISOString();
}

// --- Supabase client ---
// Prefer SUPABASE_SERVICE_ROLE_KEY (canon). Fallback to older names so you don't get blocked.
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY;

if (!process.env.SUPABASE_URL) {
  throw new Error("Missing env: SUPABASE_URL");
}
if (!supabaseKey) {
  throw new Error(
    "Missing env: SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY)"
  );
}

const supabase = createClient(process.env.SUPABASE_URL, supabaseKey);

// --- Health routes ---
app.get("/", (_req, res) => res.send("Vitaliage Push API ✅"));
app.get("/ping", (_req, res) => res.json({ ok: true }));

// --- Resolved Bundle ---
app.get("/resolved-bundle", async (req, res) => {
  try {
    const userId = req.query.userId ?? null;
    const dayKey = req.query.dayKey;
    const windowDays = req.query.windowDays ? Number(req.query.windowDays) : 28;

    if (!dayKey) {
      return res.status(400).json({
        ok: false,
        error: "Missing required query param: dayKey (YYYY-MM-DD)",
      });
    }

    const bundle = await buildResolvedBundle({
      supabase, // ✅ required so builder can fetch latest anchors
      userId,
      bundleDayKey: dayKey,
      windowDays,
    });

    return res.json({ ok: true, bundle });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err.message || "Bad Request",
    });
  }
});

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

  if (!token)
    return res.status(400).json({ ok: false, error: "Missing 'token'" });

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
    return res
      .status(500)
      .json({ ok: false, error: err.message || String(err) });
  }
}

app.post("/push", handleSend);
app.post("/api/push", handleSend);
app.post("/push/send", handleSend);

// --- push to the most recent active device ---
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
      return res.status(500).json({
        ok: false,
        error: "Supabase query failed",
        detail: error.message,
      });
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
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
      detail: err.message,
    });
  }
});

// =======================================================
// OFFICE MEASUREMENTS (Staff entry)
// Table: office_measurements
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
    if (!dk)
      return res.status(400).json({ ok: false, error: "invalid_measuredAt" });

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
      .select(
        "id,user_id,measured_at,day_key,bp_systolic,bp_diastolic,quality,device,operator"
      )
      .limit(1);

    if (error) {
      console.error("Supabase insert error in /office/measurements:", error);
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
// Table: conneqt_assessments
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

      brachialSystolic,
      brachialDiastolic,

      centralSystolic,
      centralDiastolic,

      heartRate,

      augmentationIndex,
      augmentationPressure,
      pulsePressureAmplification,
      sevr,
      centralPulsePressure,
      arterialAge,

      reportPdfUrl,
    } = payload;

    const cleanUserId = uuidRegex.test(userId || "") ? userId : null;

    const tsIso = toIsoOrNull(measuredAt) || new Date().toISOString();
    const dk = dayKeyUtc(tsIso);
    if (!dk)
      return res.status(400).json({ ok: false, error: "invalid_measuredAt" });

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
      console.error("Supabase insert error in /office/conneqt:", error);
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
    if (!dk)
      return res.status(400).json({ ok: false, error: "invalid_measuredAt" });

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
      console.error("Supabase insert error in /office/tanita:", error);
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
      leftAttempts,
      rightAttempts,
      notes,
    } = payload;

    const cleanUserId = uuidRegex.test(userId || "") ? userId : null;
    const tsIso = toIsoOrNull(measuredAt) || new Date().toISOString();
    const dk = dayKeyUtc(tsIso);
    if (!dk)
      return res.status(400).json({ ok: false, error: "invalid_measuredAt" });

    const hasAny =
      leftBest != null ||
      rightBest != null ||
      (Array.isArray(leftAttempts) && leftAttempts.length) ||
      (Array.isArray(rightAttempts) && rightAttempts.length);

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
      console.error("Supabase insert error in /office/grip:", error);
      return res.status(500).json({
        ok: false,
        error: "db_insert_failed",
        detail: error.message || error.code,
      });
    }

    return res.status(200).json({ ok: true, assessment: data?.[0] || null });
  } catch (err) {
    console.error("Error in POST /office/grip:", err);
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err.message });
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
    if (!dk)
      return res.status(400).json({ ok: false, error: "invalid_measuredAt" });

    const hasAny =
      rmrKcalDay != null || vo2MlMin != null || vco2MlMin != null || rer != null;

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
      console.error("Supabase insert error in /office/rmr:", error);
      return res.status(500).json({
        ok: false,
        error: "db_insert_failed",
        detail: error.message || error.code,
      });
    }

    return res.status(200).json({ ok: true, assessment: data?.[0] || null });
  } catch (err) {
    console.error("Error in POST /office/rmr:", err);
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err.message });
  }
});

// -------------------------------------------------------
// STATIC + DASHBOARD SPA (MUST BE AFTER API ROUTES)
// -------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));
app.use("/dashboard", express.static(path.join(__dirname, "public", "dashboard")));
app.get(/^\/dashboard(\/.*)?$/, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard", "index.html"));
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
