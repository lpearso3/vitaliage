// server.js
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");               // 👈 NEW
require("dotenv").config();
const { sendPush } = require("./apns");

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json({ limit: "1mb" }));

// 👇 NEW: static file hosting for dashboard build
// Serve any general static assets from /public (optional but handy)
app.use(express.static(path.join(__dirname, "public")));

// Serve the React dashboard under /dashboard
app.use(
  "/dashboard",
  express.static(path.join(__dirname, "public", "dashboard"))
);

// SPA fallback for any /dashboard/* route
app.get("/dashboard/*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard", "index.html"));
});

// --- Shared helpers / regex ---
const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

// --- UPDATED: receive daily health snapshot from iOS app and store in Supabase ---
app.post("/snapshot", async (req, res) => {
  try {
    const snapshot = req.body || {};

    console.log("📬 Received /snapshot payload:");
    console.log(JSON.stringify(snapshot, null, 2));

    const {
      userId,            // optional; can be null
      id: externalId,    // DailySnapshotDTO.id
      date,              // ISO string from app, e.g. 2025-11-30T06:00:00Z
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
      sleep,             // { totalMinutes, goalMinutes, metGoal }
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
      sleep_met_goal:
        typeof sleep?.metGoal === "boolean" ? sleep.metGoal : null,

      raw_json: snapshot,
    };

    const { error } = await supabase
      .from("daily_snapshots")
      .insert(row);

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

// --- NEW: fetch daily snapshots for a user/date range ---
app.get("/daily-snapshots", async (req, res) => {
  try {
    const { userId, from, to, limit } = req.query;

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

    // Optional: filter by userId if it's a valid UUID
    if (userId && uuidRegex.test(userId)) {
      query = query.eq("user_id", userId);
    }

    // Optional: date range filters (from/to are ISO strings)
    if (from) {
      query = query.gte("snapshot_date", from);
    }
    if (to) {
      query = query.lte("snapshot_date", to);
    }

    // Optional: limit (default 7)
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

    const snapshots = (data || []).map((row) => {
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

      return {
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
    });

    return res.json({ ok: true, snapshots });
  } catch (err) {
    console.error("Error in GET /daily-snapshots:", err);
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err.message });
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
