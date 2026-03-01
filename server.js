// server.js
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
require("dotenv").config();
const { sendPush } = require("./apns");

const {
  buildResolvedBundle,
} = require("./services/resolvedBundle/buildResolvedBundle");

const {
  updateStreak,
  checkMilestoneAchievements,
  getUserStreaks,
} = require("./services/streaks/updateStreaks");

const {
  generateAndStoreInsights,
  getActiveInsights,
} = require("./services/insights/generateInsights");

const {
  PROVIDERS,
  getProvider,
  listProviders,
  normalizeProviderData,
} = require("./services/integrations/providers");

// --- Structured logging helper (defined early for middleware use) ---
function structuredLog(event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

const app = express();
app.set("trust proxy", 1);

// --- Security headers (replaces helmet.js) ---
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0"); // modern browsers; CSP is preferred
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.removeHeader("X-Powered-By");
  next();
});

// --- CORS: restrict to iOS app + local dev ---
const ALLOWED_ORIGINS = [
  "capacitor://com.vitaliage",        // iOS WKWebView (Capacitor-style)
  "ionic://com.vitaliage",             // Ionic native
  "http://localhost:3000",             // local dev
  "http://localhost:8080",             // local dev alt
];
app.use(
  cors({
    origin(origin, cb) {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error("CORS: origin not allowed"));
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Vitaliage-Key"],
    maxAge: 86400, // preflight cache 24h
  })
);

// --- In-memory rate limiter ---
const RATE_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_MAX_REQUESTS = 60;     // 60 req/min per IP
const rateBuckets = new Map();

// Cleanup stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.windowStart > RATE_WINDOW_MS * 2) rateBuckets.delete(key);
  }
}, 5 * 60 * 1000);

app.use((req, res, next) => {
  // Skip rate limiting for health checks
  if (req.path === "/" || req.path === "/ping") return next();

  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  let bucket = rateBuckets.get(ip);

  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }

  bucket.count++;

  // Set standard rate-limit headers
  res.setHeader("X-RateLimit-Limit", RATE_MAX_REQUESTS);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, RATE_MAX_REQUESTS - bucket.count));
  res.setHeader("X-RateLimit-Reset", Math.ceil((bucket.windowStart + RATE_WINDOW_MS) / 1000));

  if (bucket.count > RATE_MAX_REQUESTS) {
    structuredLog("rate_limited", { ip, path: req.path });
    return res.status(429).json({
      ok: false,
      error: "too_many_requests",
      message: "Rate limit exceeded. Try again shortly.",
    });
  }
  next();
});

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

// --- Integration hygiene guards ---
const REQUIRED_BUNDLE_KEYS = [
  "user_id",
  "bundle_day_key",
  "window_days",
  "daily_snapshot_trends",
  "daily_snapshots",
  "latest_anchors",
  "resolved_metrics",
  "resolved_metrics_provenance",
  "derived_metrics",
  "confidence",
  "flags",
  "provenance_summary",
  "bundle_hash",
];

function hasDeepKey(obj, targetKey) {
  if (!obj || typeof obj !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(obj, targetKey)) return true;
  for (const v of Object.values(obj)) {
    if (hasDeepKey(v, targetKey)) return true;
  }
  return false;
}

function validateBundleShape(bundle) {
  if (!bundle || typeof bundle !== "object") {
    return {
      ok: false,
      error: "Invalid bundle shape: bundle must be an object.",
    };
  }

  const missing = REQUIRED_BUNDLE_KEYS.filter(
    (k) => !Object.prototype.hasOwnProperty.call(bundle, k)
  );
  if (missing.length) {
    return {
      ok: false,
      error: `Invalid bundle shape: missing required keys: ${missing.join(", ")}`,
    };
  }

  if (
    typeof bundle.bundle_hash !== "string" ||
    bundle.bundle_hash.length === 0
  ) {
    return {
      ok: false,
      error: "Invalid bundle shape: bundle_hash must be a non-empty string.",
    };
  }

  const conf = bundle.confidence;
  if (!conf || typeof conf !== "object") {
    return {
      ok: false,
      error: "Invalid bundle shape: missing confidence object.",
    };
  }

  if (Object.prototype.hasOwnProperty.call(conf, "metrics")) {
    return {
      ok: false,
      error:
        "Invalid bundle shape: confidence.metrics is not allowed. Use confidence.overall, confidence.trends, and confidence.resolved only.",
    };
  }

  if (hasDeepKey(conf, "metrics")) {
    return {
      ok: false,
      error:
        "Invalid bundle shape: confidence.metrics-like key detected inside confidence (forbidden).",
    };
  }

  const hasOverall = Object.prototype.hasOwnProperty.call(conf, "overall");
  const hasTrends = Object.prototype.hasOwnProperty.call(conf, "trends");
  const hasResolved = Object.prototype.hasOwnProperty.call(conf, "resolved");

  if (!hasOverall || !hasTrends || !hasResolved) {
    return {
      ok: false,
      error:
        "Invalid bundle shape: confidence must include overall, trends, and resolved.",
    };
  }

  return { ok: true };
}

/**
 * Identity canon (CURRENT STATE):
 * - Your iOS "stable device UUID" is treated as the app's userId for now.
 * - daily_snapshots.user_id uses that UUID (so buildResolvedBundle works today).
 * - devices.user_id MUST remain NULL because it has an FK (likely to auth.users).
 *   If you write iOS UUID into devices.user_id, it will 500 with devices_user_id_fkey.
 */
function getAppUserIdFromAny(obj) {
  const raw = obj?.userId ?? obj?.user_id ?? null;
  if (!raw) return null;
  const s = String(raw);
  return uuidRegex.test(s) ? s : null;
}

// --- Supabase client ---
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

// --- Request logging middleware ---
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    // Only log API routes (skip static files)
    if (req.path.startsWith("/dashboard") || req.path.includes(".")) return;
    structuredLog("http_request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      userId: getAppUserIdFromAny(req.method === "GET" ? req.query : req.body) || null,
    });
  });
  next();
});

// --- API key authentication middleware ---
// Set VITALIAGE_API_KEY in Render env vars. iOS sends it as X-Vitaliage-Key header.
// Skip auth on health checks, static assets, and the dashboard.
const API_KEY = process.env.VITALIAGE_API_KEY || null;

function requireApiKey(req, res, next) {
  // If no key is configured, allow all (dev mode)
  if (!API_KEY) return next();

  // Skip auth for health checks and static assets
  const openPaths = ["/", "/ping", "/db-check", "/__routes"];
  if (openPaths.includes(req.path)) return next();
  if (req.path.startsWith("/dashboard") || req.path.startsWith("/docs")) return next();

  const clientKey = req.headers["x-vitaliage-key"];
  if (!clientKey || clientKey !== API_KEY) {
    structuredLog("auth_rejected", { path: req.path, method: req.method });
    return res.status(401).json({ ok: false, error: "unauthorized", message: "Invalid or missing API key" });
  }
  next();
}
app.use(requireApiKey);

// --- Health routes ---
app.get("/", (_req, res) => res.send("Vitaliage Push API ✅"));
app.get("/ping", (_req, res) => res.json({ ok: true }));

// --- OpenAPI contract (authoritative) ---
app.get("/docs/api-contract.yaml", (_req, res) => {
  try {
    res.setHeader("Content-Type", "application/yaml; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(path.join(__dirname, "docs", "api-contract.yaml"));
  } catch (_e) {
    return res
      .status(500)
      .json({ ok: false, error: "Failed to serve api-contract.yaml" });
  }
});

// --- Resolved Bundle ---
// Requires userId (the app's stable UUID) so we never mix global/null-user data.
app.get("/resolved-bundle", async (req, res) => {
  try {
    const userId = getAppUserIdFromAny(req.query);
    const dayKey = req.query.dayKey;
    const windowDays = req.query.windowDays ? Number(req.query.windowDays) : 28;

    if (!dayKey) {
      return res.status(400).json({
        ok: false,
        error: "Missing required query param: dayKey (YYYY-MM-DD)",
      });
    }

    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "missing_or_invalid_userId",
        message:
          "Provide a valid userId (UUID) as query param: ?userId=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      });
    }

    const t0 = Date.now();
    const bundle = await buildResolvedBundle({
      supabase,
      userId, // IMPORTANT: this is the app UUID stored in daily_snapshots.user_id
      bundleDayKey: dayKey,
      windowDays,
    });
    const buildMs = Date.now() - t0;

    const shape = validateBundleShape(bundle);
    if (!shape.ok) {
      structuredLog("bundle_build_error", { userId, dayKey, windowDays, error: shape.error, build_ms: buildMs });
      return res.status(500).json({ ok: false, error: shape.error });
    }

    structuredLog("bundle_build_ok", {
      userId,
      dayKey,
      windowDays,
      build_ms: buildMs,
      bundle_hash: bundle.bundle_hash,
      readiness_score: bundle.derived_metrics?.readiness?.score ?? null,
      readiness_state: bundle.derived_metrics?.readiness?.state ?? null,
      confidence_overall: bundle.confidence?.overall?.score ?? null,
      snapshot_count: bundle.daily_snapshots?.length ?? 0,
    });

    return res.json({ ok: true, bundle });
  } catch (err) {
    structuredLog("bundle_build_exception", { userId: getAppUserIdFromAny(req.query), error: err.message });
    return res.status(500).json({
      ok: false,
      error: err.message || "Internal Server Error",
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

// =======================================================
// WEARABLE DAILY SNAPSHOT INGEST
// Endpoint: POST /snapshot
// Table: daily_snapshots
//
// REQUIRES userId (UUID) to prevent mixing.
// IMPORTANT: Match Supabase schema exactly.
// - Uses snapshot_date (timestamptz)
// - DOES NOT write: day_key, source, device
// - Keep client metadata inside raw_json
// =======================================================
app.post("/snapshot", async (req, res) => {
  try {
    const body = req.body || {};

    const userId = getAppUserIdFromAny(body);
    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "missing_or_invalid_userId",
        message:
          'Provide a valid userId (UUID) in JSON body: { "userId": "..." }',
      });
    }

    const snapshotDateIso =
      toIsoOrNull(body.date || body.snapshot_date || body.snapshotDate) ||
      new Date().toISOString();

    const snapshotDate = new Date(snapshotDateIso);
    if (isNaN(snapshotDate.getTime())) {
      return res.status(400).json({ ok: false, error: "invalid_date" });
    }

    // NOTE: Only include columns that exist in public.daily_snapshots
    // day_key enables upsert deduplication (one snapshot per user per day)
    const dk = dayKeyUtc(snapshotDate);
    const payload = {
      user_id: userId, // IMPORTANT: this is app UUID (current, pre-auth)
      snapshot_date: snapshotDate.toISOString(),
      day_key: dk,

      steps: body.steps ?? null,
      resting_hr: body.restingHR ?? body.resting_hr ?? null,
      hrv: body.hrv ?? null,
      vo2_max: body.vo2Max ?? body.vo2_max ?? null,
      respiratory_rate: body.respiratoryRate ?? body.respiratory_rate ?? null,
      glucose_mg_dl: body.glucoseMgDl ?? body.glucose_mg_dl ?? null,
      bp_systolic: body.bpSystolic ?? body.bp_systolic ?? null,
      bp_diastolic: body.bpDiastolic ?? body.bp_diastolic ?? null,

      sleep_total_minutes:
        body.sleep?.totalMinutes ?? body.sleep_total_minutes ?? null,
      sleep_goal_minutes:
        body.sleep?.goalMinutes ?? body.sleep_goal_minutes ?? null,
      sleep_met_goal: body.sleep?.metGoal ?? body.sleep_met_goal ?? null,

      weight_kg: body.weightKg ?? body.weight_kg ?? null,
      body_fat_percent:
        body.bodyFatPercent ??
        body.body_fat_percent ??
        body.body_fat_pct ??
        null,
      waist_cm: body.waistCm ?? body.waist_cm ?? null,
      calories_in: body.caloriesIn ?? body.calories_in ?? null,
      protein_g: body.proteinG ?? body.protein_g ?? null,
      carb_g: body.carbG ?? body.carb_g ?? null,
      fat_g: body.fatG ?? body.fat_g ?? null,
      hydration_ml: body.hydrationMl ?? body.hydration_ml ?? null,

      raw_json: body,
    };

    const hasAny =
      payload.steps != null ||
      payload.resting_hr != null ||
      payload.hrv != null ||
      payload.vo2_max != null ||
      payload.respiratory_rate != null ||
      payload.glucose_mg_dl != null ||
      payload.bp_systolic != null ||
      payload.bp_diastolic != null ||
      payload.sleep_total_minutes != null ||
      payload.sleep_goal_minutes != null ||
      payload.sleep_met_goal != null ||
      payload.weight_kg != null ||
      payload.body_fat_percent != null ||
      payload.waist_cm != null ||
      payload.calories_in != null ||
      payload.protein_g != null ||
      payload.carb_g != null ||
      payload.fat_g != null ||
      payload.hydration_ml != null;

    if (!hasAny) {
      return res.status(400).json({
        ok: false,
        error: "empty_snapshot",
        message: "Provide at least one wearable metric.",
      });
    }

    // Upsert: if a row for this (user_id, day_key) already exists, update it.
    // REQUIRES: unique constraint on (user_id, day_key) in Supabase.
    const { data, error } = await supabase
      .from("daily_snapshots")
      .upsert(payload, { onConflict: "user_id,day_key" })
      .select("*")
      .limit(1);

    if (error) {
      structuredLog("snapshot_insert_error", { userId, error: error.message || error.code });
      return res.status(500).json({
        ok: false,
        error: "db_insert_failed",
        detail: error.message || error.code,
      });
    }

    // Count how many non-null metrics were provided
    const metricCount = [
      payload.steps, payload.resting_hr, payload.hrv, payload.vo2_max,
      payload.respiratory_rate, payload.glucose_mg_dl, payload.bp_systolic,
      payload.sleep_total_minutes, payload.weight_kg, payload.body_fat_percent,
    ].filter((v) => v != null).length;

    structuredLog("snapshot_insert_ok", {
      userId,
      snapshot_date: payload.snapshot_date,
      metric_count: metricCount,
      id: data?.[0]?.id ?? null,
    });

    return res.status(200).json({ ok: true, snapshot: data?.[0] || null });
  } catch (err) {
    structuredLog("snapshot_insert_exception", { error: err.message });
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err.message });
  }
});

// =======================================================
// WEARABLE DAILY SNAPSHOT FETCH
// Endpoint: GET /daily-snapshots
// Table: daily_snapshots
//
// REQUIRES userId (UUID) to prevent mixing.
// Returns recent snapshots ordered by snapshot_date DESC.
// =======================================================
app.get("/daily-snapshots", async (req, res) => {
  try {
    const userId = getAppUserIdFromAny(req.query);
    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "missing_or_invalid_userId",
        message:
          "Provide a valid userId (UUID) as query param: ?userId=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 7, 1), 90);

    let query = supabase
      .from("daily_snapshots")
      .select("*")
      .eq("user_id", userId)
      .order("snapshot_date", { ascending: false })
      .limit(limit);

    // Optional date range filters (ISO 8601 strings)
    const fromIso = toIsoOrNull(req.query.from);
    const toIso = toIsoOrNull(req.query.to);
    if (fromIso) query = query.gte("snapshot_date", fromIso);
    if (toIso) query = query.lte("snapshot_date", toIso);

    const { data, error } = await query;

    if (error) {
      console.error("Supabase query error in GET /daily-snapshots:", error);
      return res.status(500).json({
        ok: false,
        error: "db_query_failed",
        detail: error.message || error.code,
      });
    }

    return res.json({ ok: true, snapshots: data || [] });
  } catch (err) {
    console.error("Error in GET /daily-snapshots:", err);
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err.message });
  }
});

// --- UPSERT device token ---
// IMPORTANT: DO NOT write devices.user_id (FK). Keep it NULL pre-auth.
app.post("/devices", async (req, res) => {
  const body = req.body || {};
  const { platform = "ios", token } = body;

  if (!token) return res.status(400).json({ error: "Missing token" });

  // We accept app userId for logging, but we do NOT write it to devices.user_id.
  const appUserId = getAppUserIdFromAny(body);

  try {
    const { error } = await supabase
      .from("devices")
      .upsert([{ user_id: null, platform, token }], {
        onConflict: "token",
        returning: "minimal",
      });

    if (error) {
      return res.status(500).json({
        error: "Database upsert failed",
        detail: error.message || error.hint || error.code,
      });
    }

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
      // include appUserId for debugging; not persisted in devices table
      app_user_id: appUserId || null,
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
    pushType,
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
// Pre-auth: cannot filter by userId because devices.user_id is NULL by design.
// (Filtering comes later when you adopt Supabase Auth.)
app.post("/push-latest", async (req, res) => {
  try {
    const {
      title = "Test from /push-latest",
      body = "This went to the most recent device",
      data,
      silent = false,
      collapseId,
      priority,
      pushType,
    } = req.body || {};

    let query = supabase
      .from("devices")
      .select("id,user_id,platform,token,active,last_seen,created_at")
      .eq("active", true)
      .order("last_seen", { ascending: false })
      .limit(1);

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
      quality,
    } = payload;

    // staff workflows may not have user bound yet; allow nullable
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
      quality,

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
      quality,

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
      quality,

      unit = "kgf",
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
      quality,

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

// =============================================================
// MORNING CHECK-IN ENDPOINTS
// =============================================================

/**
 * POST /check-in
 * Submit (or update) a daily morning check-in.
 */
app.post("/check-in", async (req, res) => {
  try {
    const {
      userId,
      energy_level,
      mood,
      sleep_quality,
      stress_level,
      notes,
    } = req.body;

    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required" });
    }

    const dayKey = dayKeyUtc(new Date());

    // Validate 1-5 range for all rating fields
    const ratings = { energy_level, mood, sleep_quality, stress_level };
    for (const [field, val] of Object.entries(ratings)) {
      if (val !== undefined && val !== null) {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 5) {
          return res.status(400).json({
            ok: false,
            error: `${field} must be an integer between 1 and 5`,
          });
        }
      }
    }

    const row = {
      user_id: userId,
      day_key: dayKey,
      energy_level: energy_level ?? null,
      mood: mood ?? null,
      sleep_quality: sleep_quality ?? null,
      stress_level: stress_level ?? null,
      notes: notes ?? null,
    };

    const { data, error } = await supabase
      .from("check_ins")
      .upsert(row, { onConflict: "user_id,day_key" })
      .select()
      .single();

    if (error) {
      console.error("Error in POST /check-in:", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    // Update check-in streak
    await updateStreak(supabase, userId, "check_in", dayKey);

    // Check milestone achievements (total check-in count)
    const { count } = await supabase
      .from("check_ins")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (count) {
      await checkMilestoneAchievements(supabase, userId, count);
    }

    structuredLog("check_in_submitted", { userId, dayKey });
    return res.status(200).json({ ok: true, checkIn: data });
  } catch (err) {
    console.error("Error in POST /check-in:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /check-ins?userId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
 * Fetch check-in history for a user.
 */
app.get("/check-ins", async (req, res) => {
  try {
    const { userId, from, to, limit } = req.query;
    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required" });
    }

    let query = supabase
      .from("check_ins")
      .select("*")
      .eq("user_id", userId)
      .order("day_key", { ascending: false });

    if (from) query = query.gte("day_key", from);
    if (to) query = query.lte("day_key", to);
    if (limit) query = query.limit(Number(limit));

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.status(200).json({ ok: true, checkIns: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================
// STREAKS & ACHIEVEMENTS ENDPOINTS
// =============================================================

/**
 * GET /streaks?userId=...
 * Get all streak records for a user.
 */
app.get("/streaks", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required" });
    }
    const streaks = await getUserStreaks(supabase, userId);
    return res.status(200).json({ ok: true, streaks });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /achievements
 * List all available achievement definitions.
 */
app.get("/achievements", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("achievements")
      .select("*")
      .order("category")
      .order("threshold_value");

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.status(200).json({ ok: true, achievements: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /user-achievements?userId=...
 * Get earned achievements for a user.
 */
app.get("/user-achievements", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required" });
    }

    const { data, error } = await supabase
      .from("user_achievements")
      .select("*, achievements(*)")
      .eq("user_id", userId)
      .order("earned_at", { ascending: false });

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.status(200).json({ ok: true, userAchievements: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================
// WEEKLY CHALLENGES ENDPOINTS
// =============================================================

/**
 * GET /challenges
 * List active challenges.
 */
app.get("/challenges", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("challenges")
      .select("*")
      .eq("active", true)
      .order("start_date", { ascending: false });

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.status(200).json({ ok: true, challenges: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /challenges/join
 * Join a challenge.
 */
app.post("/challenges/join", async (req, res) => {
  try {
    const { userId, challengeId } = req.body;
    if (!userId || !challengeId) {
      return res.status(400).json({
        ok: false,
        error: "userId and challengeId are required",
      });
    }

    const { data, error } = await supabase
      .from("user_challenges")
      .upsert(
        {
          user_id: userId,
          challenge_id: challengeId,
          joined_at: new Date().toISOString(),
          current_progress: 0,
          completed: false,
        },
        { onConflict: "user_id,challenge_id" }
      )
      .select("*, challenges(*)")
      .single();

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    structuredLog("challenge_joined", { userId, challengeId });
    return res.status(200).json({ ok: true, userChallenge: data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /user-challenges?userId=...&completed=false
 * Get user's active/completed challenges.
 */
app.get("/user-challenges", async (req, res) => {
  try {
    const { userId, completed } = req.query;
    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required" });
    }

    let query = supabase
      .from("user_challenges")
      .select("*, challenges(*)")
      .eq("user_id", userId)
      .order("joined_at", { ascending: false });

    if (completed !== undefined) {
      query = query.eq("completed", completed === "true");
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.status(200).json({ ok: true, userChallenges: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================
// PERSONALIZED INSIGHTS ENDPOINTS
// =============================================================

/**
 * GET /insights?userId=...&limit=20
 * Get active (undismissed) insights for a user.
 */
app.get("/insights", async (req, res) => {
  try {
    const { userId, limit } = req.query;
    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required" });
    }

    const insights = await getActiveInsights(
      supabase,
      userId,
      limit ? Number(limit) : 20
    );
    return res.status(200).json({ ok: true, insights });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /insights/:id/dismiss
 * Dismiss an insight.
 */
app.post("/insights/:id/dismiss", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required" });
    }

    const { data, error } = await supabase
      .from("insights")
      .update({ dismissed: true })
      .eq("id", id)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.status(200).json({ ok: true, insight: data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /insights/generate
 * Trigger insight generation from the latest resolved bundle.
 */
app.post("/insights/generate", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required" });
    }

    // Build the resolved bundle to get latest trends
    const bundle = await buildResolvedBundle(supabase, userId);
    if (!bundle) {
      return res.status(200).json({ ok: true, insights: [], message: "No data available for insight generation" });
    }

    const insights = await generateAndStoreInsights(supabase, userId, bundle);
    structuredLog("insights_generated", { userId, count: insights.length });
    return res.status(200).json({ ok: true, insights });
  } catch (err) {
    console.error("Error in POST /insights/generate:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================
// WEARABLE INTEGRATION ENDPOINTS
// =============================================================

/**
 * GET /integrations/status?userId=...
 * Check which providers are connected for a user.
 */
app.get("/integrations/status", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required" });
    }

    const { data, error } = await supabase
      .from("integration_tokens")
      .select("provider, active, created_at, updated_at")
      .eq("user_id", userId);

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    const providers = listProviders();
    const connected = new Map((data || []).map((t) => [t.provider, t]));

    const status = providers.map((p) => ({
      ...p,
      connected: connected.has(p.key) && connected.get(p.key).active,
      connectedAt: connected.get(p.key)?.created_at || null,
    }));

    return res.status(200).json({ ok: true, integrations: status });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /integrations/:provider/auth?userId=...
 * Start OAuth flow — returns redirect URL for the provider.
 */
app.get("/integrations/:provider/auth", async (req, res) => {
  try {
    const { provider } = req.params;
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required" });
    }

    const config = getProvider(provider);
    if (!config) {
      return res.status(400).json({ ok: false, error: `Unknown provider: ${provider}` });
    }

    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
    const callbackUrl = `${baseUrl}/integrations/${provider}/callback`;

    if (config.authType === "oauth2") {
      // OAuth 2.0 flow (Oura, WHOOP)
      const clientId = process.env[`${provider.toUpperCase()}_CLIENT_ID`];
      if (!clientId) {
        return res.status(500).json({ ok: false, error: `${provider} client ID not configured` });
      }

      const params = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: callbackUrl,
        scope: config.scopes,
        state: Buffer.from(JSON.stringify({ userId, provider })).toString("base64"),
      });

      const authUrl = `${config.authUrl}?${params.toString()}`;
      structuredLog("oauth_start", { provider, userId });
      return res.status(200).json({ ok: true, authUrl });
    } else if (config.authType === "oauth1a") {
      // OAuth 1.0a flow (Garmin) — simplified; full impl needs request token step
      // For now, return the auth URL info so the client can handle it
      structuredLog("oauth_start", { provider, userId, note: "oauth1a requires request token step" });
      return res.status(200).json({
        ok: true,
        authUrl: config.authUrl,
        note: "Garmin OAuth 1.0a requires a request token step. Full implementation pending developer account setup.",
      });
    }

    return res.status(400).json({ ok: false, error: "Unsupported auth type" });
  } catch (err) {
    console.error(`Error in GET /integrations/${req.params.provider}/auth:`, err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /integrations/:provider/callback
 * OAuth callback — exchanges code for tokens and stores them.
 */
app.get("/integrations/:provider/callback", async (req, res) => {
  try {
    const { provider } = req.params;
    const { code, state } = req.query;

    const config = getProvider(provider);
    if (!config) {
      return res.status(400).send("Unknown provider");
    }

    // Decode state to get userId
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, "base64").toString());
    } catch {
      return res.status(400).send("Invalid state parameter");
    }

    const { userId } = stateData;
    if (!userId) {
      return res.status(400).send("Missing userId in state");
    }

    if (config.authType === "oauth2") {
      const clientId = process.env[`${provider.toUpperCase()}_CLIENT_ID`];
      const clientSecret = process.env[`${provider.toUpperCase()}_CLIENT_SECRET`];
      const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      const callbackUrl = `${baseUrl}/integrations/${provider}/callback`;

      // Exchange code for tokens
      const tokenRes = await fetch(config.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: callbackUrl,
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error(`[integrations] Token exchange failed for ${provider}:`, errText);
        return res.status(500).send("Token exchange failed");
      }

      const tokens = await tokenRes.json();

      // Store tokens
      await supabase.from("integration_tokens").upsert(
        {
          user_id: userId,
          provider,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || null,
          token_expires_at: tokens.expires_in
            ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
            : null,
          scopes: config.scopes,
          active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" }
      );

      structuredLog("oauth_complete", { provider, userId });
      // Redirect to a success page or deep link back to the app
      return res.send(
        `<html><body><h2>Connected to ${config.name}!</h2><p>You can close this window and return to the app.</p></body></html>`
      );
    }

    return res.status(400).send("Unsupported auth type for callback");
  } catch (err) {
    console.error(`Error in /integrations/${req.params.provider}/callback:`, err);
    return res.status(500).send("OAuth callback error");
  }
});

/**
 * POST /integrations/:provider/webhook
 * Receive push data from wearable providers and normalize into daily_snapshots.
 */
app.post("/integrations/:provider/webhook", async (req, res) => {
  try {
    const { provider } = req.params;
    const config = getProvider(provider);
    if (!config) {
      return res.status(400).json({ ok: false, error: "Unknown provider" });
    }

    const payload = req.body;
    structuredLog("webhook_received", { provider, keys: Object.keys(payload) });

    // For each data type in the payload, normalize and merge into daily_snapshots
    const dataTypes = ["daily", "sleep", "recovery", "readiness"];
    const results = [];

    for (const dataType of dataTypes) {
      const normalized = normalizeProviderData(provider, dataType, payload);
      if (Object.keys(normalized).length === 0) continue;

      // Look up the user by provider webhook data (provider_user_id)
      // The actual user mapping depends on the provider's webhook format
      // For now, if userId is in the payload or headers, use it
      const userId = payload.userId || payload.user_id || req.headers["x-user-id"];
      if (!userId) continue;

      const dayKey = dayKeyUtc(new Date());
      const { error } = await supabase.from("daily_snapshots").upsert(
        {
          user_id: userId,
          day_key: dayKey,
          ...normalized,
          source: provider,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,day_key" }
      );

      if (error) {
        console.error(`[webhook] Error upserting ${provider}/${dataType}:`, error.message);
      } else {
        results.push({ dataType, fields: Object.keys(normalized) });
      }
    }

    return res.status(200).json({ ok: true, processed: results });
  } catch (err) {
    console.error(`Error in POST /integrations/${req.params.provider}/webhook:`, err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /integrations/:provider
 * Disconnect a wearable provider.
 */
app.delete("/integrations/:provider", async (req, res) => {
  try {
    const { provider } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required" });
    }

    const { error } = await supabase
      .from("integration_tokens")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("provider", provider);

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    structuredLog("integration_disconnected", { provider, userId });
    return res.status(200).json({ ok: true, message: `${provider} disconnected` });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================
// CLINICIAN DASHBOARD ENDPOINTS
// =============================================================

/**
 * GET /clinician/patients?clinicianId=...
 * List patients with summary health status.
 */
app.get("/clinician/patients", async (req, res) => {
  try {
    const { clinicianId } = req.query;
    // For now, list all users who have snapshots (clinician-patient mapping can be added later)
    const { data: snapshots, error } = await supabase
      .from("daily_snapshots")
      .select("user_id, day_key, steps, sleep_total_minutes, resting_hr, hrv")
      .order("day_key", { ascending: false });

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    // Group by user, take latest snapshot per user
    const userMap = new Map();
    for (const s of snapshots || []) {
      if (!userMap.has(s.user_id)) {
        userMap.set(s.user_id, {
          userId: s.user_id,
          lastActivity: s.day_key,
          latestSnapshot: s,
        });
      }
    }

    const patients = Array.from(userMap.values());
    return res.status(200).json({ ok: true, patients });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /clinician/patient/:userId/digest
 * Weekly digest for a specific patient.
 */
app.get("/clinician/patient/:userId/digest", async (req, res) => {
  try {
    const { userId } = req.params;
    const { windowDays } = req.query;
    const days = windowDays ? Number(windowDays) : 7;

    // Build resolved bundle for the patient
    const bundle = await buildResolvedBundle(supabase, userId, { windowDays: days });

    if (!bundle) {
      return res.status(200).json({
        ok: true,
        digest: null,
        message: "No data available for this patient",
      });
    }

    // Generate insights for this digest
    const insights = await generateAndStoreInsights(supabase, userId, bundle);

    // Get recent check-ins
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
    const { data: checkIns } = await supabase
      .from("check_ins")
      .select("*")
      .eq("user_id", userId)
      .gte("day_key", dayKeyUtc(fromDate))
      .order("day_key", { ascending: false });

    // Get streaks
    const streaks = await getUserStreaks(supabase, userId);

    const digest = {
      userId,
      windowDays: days,
      generatedAt: new Date().toISOString(),
      resolvedBundle: bundle,
      insights,
      checkIns: checkIns || [],
      streaks,
    };

    return res.status(200).json({ ok: true, digest });
  } catch (err) {
    console.error(`Error in GET /clinician/patient/${req.params.userId}/digest:`, err);
    return res.status(500).json({ ok: false, error: err.message });
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

// -------------------------------------------------------
// STATIC + DASHBOARD SPA (MUST BE AFTER API ROUTES)
// -------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/dashboard",
  express.static(path.join(__dirname, "public", "dashboard"))
);
app.get(/^\/dashboard(\/.*)?$/, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard", "index.html"));
});

// --- Start server ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
