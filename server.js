// server.js (ESM)
// Node 20+, "type": "module" in package.json

import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

// Optional: load .env in local dev. On Render, env vars are injected automatically.
try {
  const { config } = await import("dotenv");
  config();
} catch (_) {}

const app = express();

// --- Middleware ---
app.use(cors());               // TEMP: permissive; you can restrict origins later
app.use(express.json());       // JSON body parser

// --- Supabase ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠️ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- Health + root ---
app.get("/", (_req, res) => res.send("Vitaliage backend is running!"));
app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.get("/ping", (_req, res) => res.json({ ok: true }));

// Check DB connectivity and return a sample device row (if any)
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

// --- Device registration (APNs tokens) ---
// Upsert by 'token' (ensure a unique index on devices.token in your DB)
app.post("/devices", async (req, res) => {
  const { userId = null, platform = "ios", token } = req.body || {};
  if (!platform || !token) {
    return res.status(400).json({ error: "platform and token are required" });
  }

  try {
    // idempotent upsert on token
    const { error: upsertErr } = await supabase
      .from("devices")
      .upsert([{ user_id: userId, platform: String(platform).toLowerCase(), token }], {
        onConflict: "token",
        returning: "minimal",
      });

    if (upsertErr) {
      return res.status(500).json({
        error: "Database upsert failed",
        detail: upsertErr.message || upsertErr.code,
      });
    }

    // best-effort last_seen update
    await supabase.from("devices").update({ last_seen: new Date().toISOString() }).eq("token", token);

    // return a clean subset
    const { data: rows, error: selErr } = await supabase
      .from("devices")
      .select("id,user_id,platform,token,active,last_seen,created_at")
      .eq("token", token)
      .limit(1);

    if (selErr) return res.json({ message: "Device token stored" });
    return res.json({ message: "Device token stored", device: rows?.[0] || null });
  } catch (e) {
    return res.status(500).json({ error: "Unexpected server error", detail: e.message });
  }
});

// List devices for a specific user
app.get("/devices/:userId", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("devices")
      .select("id,user_id,platform,token,active,last_seen,created_at")
      .eq("user_id", req.params.userId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ devices: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Metrics ingestion (HealthKit -> Supabase) ---
// Expects: { userId, metric, value_num, unit, measured_at }
// NOTE: metric must be a valid enum value in 'metric_type'
//   current enum: hrv, resting_hr, sleep_duration, steps, weight, glucose, active_energy
//   If you want VO2, run: ALTER TYPE metric_type ADD VALUE IF NOT EXISTS 'vo2';
app.post("/metrics", async (req, res) => {
  try {
    const {
      userId = null,
      metric,
      value_num,
      unit = null,
      measured_at = new Date().toISOString(),
    } = req.body || {};

    if (!metric || value_num === undefined || value_num === null) {
      return res.status(400).json({ error: "metric and value_num are required" });
    }

    const { error } = await supabase
      .from("health_metrics")
      .insert([{ user_id: userId, metric, value_num, unit, measured_at }]);

    if (error) {
      // Helpful error message if enum mismatch
      return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Debug: list registered routes ---
function listRoutes(app) {
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
app.get("/__routes", (_req, res) => res.json(listRoutes(app)));

// --- 404 & error handlers ---
app.use((req, res) => res.status(404).json({ error: "Not found", path: req.originalUrl }));
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

// --- Start server ---
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
