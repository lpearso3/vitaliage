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
  generateDailySummary,
  streamChatResponse,
  generateMetricExplanation,
  generateReadinessPlan,
  generateFeedbackLoopInsights,
  generateNutritionInsights,
  checkSupplementInteractions,
} = require("./services/ai/claudeService");

const {
  PROVIDERS,
  getProvider,
  listProviders,
  normalizeProviderData,
} = require("./services/integrations/providers");

const {
  computeBiologicalAge,
} = require("./services/biologicalAge/computeBiologicalAge");

const {
  sendMorningReadinessNotifications,
} = require("./services/notifications/morningReadiness");

const {
  startCronJobs,
  stopCronJobs,
} = require("./services/notifications/scheduler");

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
const RATE_MAX_REQUESTS = 300;    // 300 req/min per IP (raised for backfill + app usage)
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
  if (req.path.startsWith("/dashboard") || req.path.startsWith("/docs") || req.path.startsWith("/assets")) return next();

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
// MORNING READINESS NOTIFICATIONS
// =======================================================
// POST /admin/send-morning-readiness — Trigger morning readiness notifications
app.post("/admin/send-morning-readiness", async (req, res) => {
  try {
    const results = await sendMorningReadinessNotifications(supabase, { sendPush });
    return res.status(200).json({
      ok: true,
      sent: results.sent,
      failed: results.failed,
      skipped: results.skipped,
      errors: results.errors && results.errors.length > 0 ? results.errors : undefined,
    });
  } catch (err) {
    console.error("Error in /admin/send-morning-readiness:", err);
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
    // bundleDayKey = today in UTC (YYYY-MM-DD)
    const todayKey = new Date().toISOString().slice(0, 10);
    const bundle = await buildResolvedBundle({
      supabase,
      userId,
      bundleDayKey: todayKey,
      windowDays: 28,
    });
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
// AI ENDPOINTS (Claude-powered)
// =============================================================

/**
 * POST /ai/summary
 * Generate (or return cached) daily AI health summary.
 * Body: { userId }
 * Returns: { ok, summary: { text, dayKey, generatedAt } }
 */
app.post("/ai/summary", async (req, res) => {
  try {
    const userId = getAppUserIdFromAny(req.body);
    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required" });
    }

    const dayKey = new Date().toISOString().slice(0, 10);

    // Check cache first
    const { data: cached } = await supabase
      .from("ai_summaries")
      .select("summary_text, created_at")
      .eq("user_id", userId)
      .eq("day_key", dayKey)
      .limit(1)
      .maybeSingle();

    if (cached?.summary_text) {
      structuredLog("ai_summary_cache_hit", { userId, dayKey });
      return res.status(200).json({
        ok: true,
        summary: {
          text: cached.summary_text,
          dayKey,
          generatedAt: cached.created_at,
          cached: true,
        },
      });
    }

    // Build resolved bundle for context
    const bundle = await buildResolvedBundle({
      supabase,
      userId,
      bundleDayKey: dayKey,
      windowDays: 28,
    });

    if (!bundle) {
      return res.status(200).json({
        ok: true,
        summary: {
          text: "Not enough data yet to generate a summary. Keep wearing your device and we'll have insights for you soon!",
          dayKey,
          generatedAt: new Date().toISOString(),
          cached: false,
        },
      });
    }

    // Call Claude
    const summaryText = await generateDailySummary(bundle);

    // Cache in Supabase (upsert)
    await supabase.from("ai_summaries").upsert(
      {
        user_id: userId,
        day_key: dayKey,
        summary_text: summaryText,
        model: "claude-sonnet-4-5-20250929",
      },
      { onConflict: "user_id,day_key" }
    );

    structuredLog("ai_summary_generated", { userId, dayKey, length: summaryText.length });

    return res.status(200).json({
      ok: true,
      summary: {
        text: summaryText,
        dayKey,
        generatedAt: new Date().toISOString(),
        cached: false,
      },
    });
  } catch (err) {
    console.error("Error in POST /ai/summary:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /ai/chat
 * Streamed AI health coach chat via Server-Sent Events.
 * Body: { userId, messages: [{ role: "user"|"assistant", content: "..." }] }
 * Returns: SSE stream with text chunks, then [DONE].
 */
app.post("/ai/chat", async (req, res) => {
  try {
    const userId = getAppUserIdFromAny(req.body);
    const { messages } = req.body;

    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required" });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ ok: false, error: "messages array is required" });
    }

    // Set up SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
    res.flushHeaders();

    // Build resolved bundle for context
    const dayKey = new Date().toISOString().slice(0, 10);
    let bundle = null;
    try {
      bundle = await buildResolvedBundle({
        supabase,
        userId,
        bundleDayKey: dayKey,
        windowDays: 28,
      });
    } catch (bundleErr) {
      console.error("Warning: Could not build bundle for chat:", bundleErr.message);
      // Continue without bundle — Claude can still chat
    }

    // Stream response
    let fullResponse = "";
    await streamChatResponse(bundle, messages, (chunk) => {
      fullResponse += chunk;
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
    });

    // Send done signal
    res.write(`data: ${JSON.stringify({ done: true, fullText: fullResponse })}\n\n`);
    res.end();

    structuredLog("ai_chat_response", {
      userId,
      messageCount: messages.length,
      responseLength: fullResponse.length,
    });
  } catch (err) {
    console.error("Error in POST /ai/chat:", err);
    // If headers already sent, close the stream with error
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    } else {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
});

/**
 * POST /ai/metric-explain
 * Generate an AI-powered explanation of a specific health metric.
 * Body: { userId, metric }
 * metric: "steps" | "sleep" | "heart_rate" | "hrv" | "readiness"
 */
app.post("/ai/metric-explain", async (req, res) => {
  try {
    const { userId, metric } = req.body;
    if (!userId || !metric) {
      return res.status(400).json({ ok: false, error: "userId and metric required" });
    }

    const validMetrics = ["steps", "sleep", "heart_rate", "hrv", "readiness"];
    if (!validMetrics.includes(metric)) {
      return res.status(400).json({ ok: false, error: `Invalid metric. Must be one of: ${validMetrics.join(", ")}` });
    }

    const todayKey = new Date().toISOString().slice(0, 10);

    // Check cache (keyed by user + metric + day)
    const cacheKey = `${metric}_${todayKey}`;
    const { data: cached } = await supabase
      .from("ai_summaries")
      .select("summary_text")
      .eq("user_id", userId)
      .eq("day_key", cacheKey)
      .maybeSingle();

    if (cached?.summary_text) {
      return res.json({ ok: true, explanation: cached.summary_text, cached: true });
    }

    // Build bundle and generate
    const bundle = await buildResolvedBundle({ supabase, userId, bundleDayKey: todayKey, windowDays: 28 });
    const explanation = await generateMetricExplanation(bundle, metric);

    // Cache it
    await supabase.from("ai_summaries").upsert(
      { user_id: userId, day_key: cacheKey, summary_text: explanation, model: "claude-sonnet-4-5" },
      { onConflict: "user_id,day_key" }
    );

    structuredLog("ai_metric_explain", { userId, metric, responseLength: explanation.length });
    return res.json({ ok: true, explanation, cached: false });
  } catch (err) {
    console.error("Error in POST /ai/metric-explain:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /ai/readiness-plan
 * Generate an AI-powered personalized daily plan based on readiness.
 * Body: { userId, score?, band?, reasons? }
 */
app.post("/ai/readiness-plan", async (req, res) => {
  try {
    const { userId, score, band, reasons } = req.body;
    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId required" });
    }

    const todayKey = new Date().toISOString().slice(0, 10);

    // Check cache
    const cacheKey = `readiness_plan_${todayKey}`;
    const { data: cached } = await supabase
      .from("ai_summaries")
      .select("summary_text")
      .eq("user_id", userId)
      .eq("day_key", cacheKey)
      .maybeSingle();

    if (cached?.summary_text) {
      return res.json({ ok: true, plan: cached.summary_text, cached: true });
    }

    // Build bundle and generate
    const bundle = await buildResolvedBundle({ supabase, userId, bundleDayKey: todayKey, windowDays: 28 });
    const plan = await generateReadinessPlan(bundle, score, band, reasons || []);

    // Cache it
    await supabase.from("ai_summaries").upsert(
      { user_id: userId, day_key: cacheKey, summary_text: plan, model: "claude-sonnet-4-5" },
      { onConflict: "user_id,day_key" }
    );

    structuredLog("ai_readiness_plan", { userId, score, band, responseLength: plan.length });
    return res.json({ ok: true, plan, cached: false });
  } catch (err) {
    console.error("Error in POST /ai/readiness-plan:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /ai/feedback-loop
 * Generate feedback loop insights analyzing readiness vs activity load relationship.
 * Body: { userId }
 */
app.post("/ai/feedback-loop", async (req, res) => {
  try {
    const userId = getAppUserIdFromAny(req.body);
    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required" });
    }

    const todayKey = new Date().toISOString().slice(0, 10);

    // Check cache
    const cacheKey = `feedback_loop_${todayKey}`;
    const { data: cached } = await supabase
      .from("ai_summaries")
      .select("summary_text")
      .eq("user_id", userId)
      .eq("day_key", cacheKey)
      .maybeSingle();

    if (cached?.summary_text) {
      return res.json({ ok: true, insights: cached.summary_text, cached: true });
    }

    // Build bundle and generate
    const bundle = await buildResolvedBundle({ supabase, userId, bundleDayKey: todayKey, windowDays: 28 });

    if (!bundle) {
      return res.json({
        ok: true,
        insights: "Not enough data yet to analyze your readiness and activity patterns. Keep tracking and we'll identify your personal recovery sweet spot soon!",
        cached: false,
      });
    }

    const insights = await generateFeedbackLoopInsights(bundle);

    // Cache it
    await supabase.from("ai_summaries").upsert(
      { user_id: userId, day_key: cacheKey, summary_text: insights, model: "claude-sonnet-4-5" },
      { onConflict: "user_id,day_key" }
    );

    structuredLog("ai_feedback_loop", { userId, responseLength: insights.length });
    return res.json({ ok: true, insights, cached: false });
  } catch (err) {
    console.error("Error in POST /ai/feedback-loop:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /ai/nutrition-insights
 * Generate nutrition insights based on recent nutrition data.
 * Body: { userId, nutritionData: { avgCalories, avgProtein, avgCarbs, avgFat, days } }
 */
app.post("/ai/nutrition-insights", async (req, res) => {
  try {
    const { userId, nutritionData } = req.body;
    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId required" });
    }
    if (!nutritionData) {
      return res.status(400).json({ ok: false, error: "nutritionData required" });
    }

    const todayKey = new Date().toISOString().slice(0, 10);
    const cacheKey = `nutrition_${todayKey}`;

    // Check cache
    const { data: cached } = await supabase
      .from("ai_summaries")
      .select("summary_text")
      .eq("user_id", userId)
      .eq("day_key", cacheKey)
      .maybeSingle();

    if (cached?.summary_text) {
      return res.json({ ok: true, insights: cached.summary_text, cached: true });
    }

    // Build bundle and generate
    const bundle = await buildResolvedBundle({ supabase, userId, bundleDayKey: todayKey, windowDays: 28 });
    const insights = await generateNutritionInsights(bundle, nutritionData);

    // Cache it
    await supabase.from("ai_summaries").upsert(
      { user_id: userId, day_key: cacheKey, summary_text: insights, model: "claude-sonnet-4-5" },
      { onConflict: "user_id,day_key" }
    );

    structuredLog("ai_nutrition_insights", { userId, days: nutritionData.days, responseLength: insights.length });
    return res.json({ ok: true, insights, cached: false });
  } catch (err) {
    console.error("Error in POST /ai/nutrition-insights:", err);
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
    const todayKey = new Date().toISOString().slice(0, 10);
    const bundle = await buildResolvedBundle({
      supabase,
      userId,
      bundleDayKey: todayKey,
      windowDays: days,
    });

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

// =======================================================
// CLINIC TESTING SESSIONS
// =======================================================

// POST /clinic/sessions — Create a new testing session
app.post("/clinic/sessions", async (req, res) => {
  try {
    const {
      userId, sessionDate, clinicianId, sessionType = "initial",
      status = "in_progress", notes,
      hrRecoveryBest, cardioFitnessCategory, strengthPowerCategory,
      autonomicBalanceCategory, frailtyRisk, longevityRiskTier,
      personalizedPlanSummary,
    } = req.body || {};

    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });
    if (!sessionDate) return res.status(400).json({ ok: false, error: "sessionDate_required" });

    const row = {
      user_id: userId,
      session_date: sessionDate,
      clinician_id: clinicianId ?? null,
      session_type: sessionType,
      status,
      notes: notes ?? null,
      hr_recovery_best: hrRecoveryBest ?? null,
      cardio_fitness_category: cardioFitnessCategory ?? null,
      strength_power_category: strengthPowerCategory ?? null,
      autonomic_balance_category: autonomicBalanceCategory ?? null,
      frailty_risk: frailtyRisk ?? null,
      longevity_risk_tier: longevityRiskTier ?? null,
      personalized_plan_summary: personalizedPlanSummary ?? null,
    };

    const { data, error } = await supabase.from("testing_sessions").insert(row).select().limit(1);
    if (error) return res.status(500).json({ ok: false, error: "db_insert_failed", detail: error.message });
    return res.status(201).json({ ok: true, session: data?.[0] || null });
  } catch (err) {
    console.error("Error in POST /clinic/sessions:", err);
    return res.status(500).json({ ok: false, error: "internal_error", detail: err.message });
  }
});

// GET /clinic/sessions — List sessions for a user
app.get("/clinic/sessions", async (req, res) => {
  try {
    const { userId, limit = 20 } = req.query;
    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });

    const { data, error } = await supabase
      .from("testing_sessions")
      .select("*")
      .eq("user_id", userId)
      .order("session_date", { ascending: false })
      .limit(parseInt(limit));

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, sessions: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /clinic/sessions/:id — Get full session with all linked test results
app.get("/clinic/sessions/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [session, functional, vo2, labs, bodyComp, conneqt, grip, officeMeas, plans] = await Promise.all([
      supabase.from("testing_sessions").select("*").eq("id", id).single(),
      supabase.from("functional_assessments").select("*").eq("session_id", id).order("measured_at"),
      supabase.from("vo2_assessments").select("*").eq("session_id", id).order("measured_at"),
      supabase.from("lab_results").select("*").eq("session_id", id).order("collected_at"),
      supabase.from("tanita_assessments").select("*").eq("session_id", id).order("measured_at"),
      supabase.from("conneqt_assessments").select("*").eq("session_id", id).order("measured_at"),
      supabase.from("grip_strength_assessments").select("*").eq("session_id", id).order("measured_at"),
      supabase.from("office_measurements").select("*").eq("session_id", id).order("measured_at"),
      supabase.from("care_plans").select("*").eq("session_id", id).order("created_at"),
    ]);

    if (session.error) return res.status(404).json({ ok: false, error: "session_not_found" });

    return res.json({
      ok: true,
      session: session.data,
      assessments: {
        functional: functional.data || [],
        vo2: vo2.data || [],
        labs: labs.data || [],
        body_composition: bodyComp.data || [],
        conneqt: conneqt.data || [],
        grip_strength: grip.data || [],
        office_measurements: officeMeas.data || [],
      },
      plans: plans.data || [],
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /clinic/sessions/:id — Update session status, risk tier, notes
app.patch("/clinic/sessions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};
    const allowed = [
      "status", "notes", "clinicianId", "sessionType",
      "hrRecoveryBest", "cardioFitnessCategory", "strengthPowerCategory",
      "autonomicBalanceCategory", "frailtyRisk", "longevityRiskTier",
      "personalizedPlanSummary",
    ];
    const fieldMap = {
      clinicianId: "clinician_id", sessionType: "session_type",
      hrRecoveryBest: "hr_recovery_best", cardioFitnessCategory: "cardio_fitness_category",
      strengthPowerCategory: "strength_power_category",
      autonomicBalanceCategory: "autonomic_balance_category",
      frailtyRisk: "frailty_risk", longevityRiskTier: "longevity_risk_tier",
      personalizedPlanSummary: "personalized_plan_summary",
    };

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates[fieldMap[key] || key] = req.body[key];
      }
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from("testing_sessions").update(updates).eq("id", id).select().single();
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, session: data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /clinic/sessions/:id/compare/:compareId — Compare two sessions
app.get("/clinic/sessions/:id/compare/:compareId", async (req, res) => {
  try {
    const { id, compareId } = req.params;

    const fetchSession = async (sid) => {
      const [s, fn, v, lb, bc, cq, gr] = await Promise.all([
        supabase.from("testing_sessions").select("*").eq("id", sid).single(),
        supabase.from("functional_assessments").select("*").eq("session_id", sid),
        supabase.from("vo2_assessments").select("*").eq("session_id", sid),
        supabase.from("lab_results").select("*").eq("session_id", sid),
        supabase.from("tanita_assessments").select("*").eq("session_id", sid),
        supabase.from("conneqt_assessments").select("*").eq("session_id", sid),
        supabase.from("grip_strength_assessments").select("*").eq("session_id", sid),
      ]);
      return {
        session: s.data, functional: fn.data || [], vo2: v.data || [],
        labs: lb.data || [], body_composition: bc.data || [],
        conneqt: cq.data || [], grip_strength: gr.data || [],
      };
    };

    const [current, previous] = await Promise.all([fetchSession(id), fetchSession(compareId)]);
    if (!current.session || !previous.session) {
      return res.status(404).json({ ok: false, error: "one_or_both_sessions_not_found" });
    }

    return res.json({ ok: true, current, previous });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =======================================================
// FUNCTIONAL ASSESSMENTS (Sit-to-Stand, Gait, 6MWT)
// =======================================================

app.post("/clinic/functional", async (req, res) => {
  try {
    const p = req.body || {};
    const { userId, sessionId, testType, measuredAt } = p;

    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });
    if (!testType || !["sit_to_stand", "gait_speed", "six_min_walk"].includes(testType)) {
      return res.status(400).json({ ok: false, error: "invalid_test_type", allowed: ["sit_to_stand", "gait_speed", "six_min_walk"] });
    }

    const tsIso = toIsoOrNull(measuredAt) || new Date().toISOString();
    const dk = dayKeyUtc(tsIso);

    const row = {
      user_id: userId,
      session_id: sessionId ?? null,
      test_type: testType,
      measured_at: tsIso,
      day_key: dk,
      // Sit-to-Stand
      sts_time_seconds: p.stsTimeSeconds ?? null,
      sts_hands_used: p.stsHandsUsed ?? null,
      sts_balance_loss: p.stsBalanceLoss ?? null,
      sts_immediate_hr: p.stsImmediateHr ?? null,
      sts_chair_height_cm: p.stsChairHeightCm ?? null,
      // Gait Speed
      gait_time_seconds: p.gaitTimeSeconds ?? null,
      gait_speed_ms: p.gaitSpeedMs ?? null,
      gait_assistive_device: p.gaitAssistiveDevice ?? null,
      gait_interpretation: p.gaitInterpretation ?? null,
      // 6-Min Walk
      walk_distance_meters: p.walkDistanceMeters ?? null,
      walk_percent_predicted: p.walkPercentPredicted ?? null,
      walk_peak_hr: p.walkPeakHr ?? null,
      walk_recovery_hr_1min: p.walkRecoveryHr1min ?? null,
      walk_post_rpe: p.walkPostRpe ?? null,
      walk_symptoms: p.walkSymptoms ?? null,
      // Common
      percentile_age_sex: p.percentileAgeSex ?? null,
      interpretation: p.interpretation ?? null,
      notes: p.notes ?? null,
      raw_json: p,
    };

    const { data, error } = await supabase.from("functional_assessments").insert(row).select("id,user_id,test_type,measured_at").limit(1);
    if (error) return res.status(500).json({ ok: false, error: "db_insert_failed", detail: error.message });
    return res.status(201).json({ ok: true, assessment: data?.[0] || null });
  } catch (err) {
    console.error("Error in POST /clinic/functional:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/clinic/functional", async (req, res) => {
  try {
    const { userId, type, sessionId, limit = 50 } = req.query;
    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });

    let query = supabase.from("functional_assessments").select("*").eq("user_id", userId);
    if (type) query = query.eq("test_type", type);
    if (sessionId) query = query.eq("session_id", sessionId);
    query = query.order("measured_at", { ascending: false }).limit(parseInt(limit));

    const { data, error } = await query;
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, assessments: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/clinic/functional/trends", async (req, res) => {
  try {
    const { userId, type } = req.query;
    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });
    if (!type) return res.status(400).json({ ok: false, error: "type_required" });

    const { data, error } = await supabase
      .from("functional_assessments")
      .select("*")
      .eq("user_id", userId)
      .eq("test_type", type)
      .not("session_id", "is", null)
      .order("measured_at", { ascending: true });

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, trend: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =======================================================
// VO2 ASSESSMENTS (Submaximal Bike Test)
// =======================================================

app.post("/clinic/vo2", async (req, res) => {
  try {
    const p = req.body || {};
    const { userId, sessionId, measuredAt } = p;

    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });

    const tsIso = toIsoOrNull(measuredAt) || new Date().toISOString();
    const dk = dayKeyUtc(tsIso);

    const row = {
      user_id: userId,
      session_id: sessionId ?? null,
      measured_at: tsIso,
      day_key: dk,
      protocol: p.protocol ?? "precor_watt",
      final_workload_watts: p.finalWorkloadWatts ?? null,
      minute_2_hr: p.minute2Hr ?? null,
      minute_3_hr: p.minute3Hr ?? null,
      kgm_per_min: p.kgmPerMin ?? null,
      estimated_vo2_ml_kg_min: p.estimatedVo2MlKgMin ?? null,
      age_adjusted_interpretation: p.ageAdjustedInterpretation ?? null,
      hr_recovery_1min: p.hrRecovery1min ?? null,
      hr_recovery_best: p.hrRecoveryBest ?? null,
      cardio_fitness_category: p.cardioFitnessCategory ?? null,
      notes: p.notes ?? null,
      raw_json: p,
    };

    const { data, error } = await supabase.from("vo2_assessments").insert(row).select("id,user_id,measured_at,estimated_vo2_ml_kg_min").limit(1);
    if (error) return res.status(500).json({ ok: false, error: "db_insert_failed", detail: error.message });
    return res.status(201).json({ ok: true, assessment: data?.[0] || null });
  } catch (err) {
    console.error("Error in POST /clinic/vo2:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/clinic/vo2", async (req, res) => {
  try {
    const { userId, sessionId, limit = 20 } = req.query;
    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });

    let query = supabase.from("vo2_assessments").select("*").eq("user_id", userId);
    if (sessionId) query = query.eq("session_id", sessionId);
    query = query.order("measured_at", { ascending: false }).limit(parseInt(limit));

    const { data, error } = await query;
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, assessments: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/clinic/vo2/trends", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });

    const { data, error } = await supabase
      .from("vo2_assessments")
      .select("*")
      .eq("user_id", userId)
      .not("session_id", "is", null)
      .order("measured_at", { ascending: true });

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, trend: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =======================================================
// LAB RESULTS (Blood Work & Biomarkers)
// =======================================================

app.post("/clinic/labs", async (req, res) => {
  try {
    const p = req.body || {};
    const { userId, sessionId, collectedAt } = p;

    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });

    const tsIso = toIsoOrNull(collectedAt) || new Date().toISOString();
    const dk = dayKeyUtc(tsIso);

    const row = {
      user_id: userId,
      session_id: sessionId ?? null,
      collected_at: tsIso,
      day_key: dk,
      lab_name: p.labName ?? null,
      // Metabolic
      hba1c_pct: p.hba1cPct ?? null,
      fasting_glucose_mg_dl: p.fastingGlucoseMgDl ?? null,
      insulin_uiu_ml: p.insulinUiuMl ?? null,
      homa_ir: p.homaIr ?? null,
      // Lipids
      total_cholesterol: p.totalCholesterol ?? null,
      ldl_cholesterol: p.ldlCholesterol ?? null,
      hdl_cholesterol: p.hdlCholesterol ?? null,
      triglycerides: p.triglycerides ?? null,
      apob_mg_dl: p.apobMgDl ?? null,
      lpa_nmol_l: p.lpaNmolL ?? null,
      // Inflammation
      hs_crp_mg_l: p.hsCrpMgL ?? null,
      homocysteine_umol_l: p.homocysteineUmolL ?? null,
      // Hormones
      testosterone_ng_dl: p.testosteroneNgDl ?? null,
      free_testosterone: p.freeTestosterone ?? null,
      dhea_s: p.dheaS ?? null,
      cortisol_am: p.cortisolAm ?? null,
      tsh: p.tsh ?? null,
      vitamin_d_ng_ml: p.vitaminDNgMl ?? null,
      // Flexible
      additional_results: p.additionalResults ?? null,
      report_pdf_url: p.reportPdfUrl ?? null,
      notes: p.notes ?? null,
      raw_json: p,
    };

    const { data, error } = await supabase.from("lab_results").insert(row).select("id,user_id,collected_at,day_key").limit(1);
    if (error) return res.status(500).json({ ok: false, error: "db_insert_failed", detail: error.message });
    return res.status(201).json({ ok: true, labResult: data?.[0] || null });
  } catch (err) {
    console.error("Error in POST /clinic/labs:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/clinic/labs", async (req, res) => {
  try {
    const { userId, sessionId, limit = 20 } = req.query;
    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });

    let query = supabase.from("lab_results").select("*").eq("user_id", userId);
    if (sessionId) query = query.eq("session_id", sessionId);
    query = query.order("collected_at", { ascending: false }).limit(parseInt(limit));

    const { data, error } = await query;
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, labResults: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/clinic/labs/trends", async (req, res) => {
  try {
    const { userId, metric } = req.query;
    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });

    const { data, error } = await supabase
      .from("lab_results")
      .select("*")
      .eq("user_id", userId)
      .order("collected_at", { ascending: true });

    if (error) return res.status(500).json({ ok: false, error: error.message });

    // If a specific metric requested, extract just that column trend
    if (metric && data) {
      const trend = data
        .filter((r) => r[metric] != null)
        .map((r) => ({ date: r.day_key, value: r[metric], session_id: r.session_id }));
      return res.json({ ok: true, metric, trend });
    }

    return res.json({ ok: true, labResults: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =======================================================
// CARE PLANS (Workout, Nutrition, Lifestyle)
// =======================================================

app.post("/clinic/plans", async (req, res) => {
  try {
    const p = req.body || {};
    const { userId, sessionId, planType } = p;

    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });
    if (!planType || !["workout", "nutrition", "lifestyle", "combined"].includes(planType)) {
      return res.status(400).json({ ok: false, error: "invalid_plan_type" });
    }

    // Supersede any existing active plan of the same type for this user
    if (p.supersedePrevious !== false) {
      await supabase
        .from("care_plans")
        .update({ status: "superseded", updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("plan_type", planType)
        .eq("status", "active");
    }

    const row = {
      user_id: userId,
      session_id: sessionId ?? null,
      plan_type: planType,
      title: p.title ?? null,
      summary: p.summary ?? null,
      plan_body: p.planBody ?? null,
      goals: p.goals ?? null,
      start_date: p.startDate ?? null,
      end_date: p.endDate ?? null,
      status: "active",
      adherence_pct: null,
      pdf_url: p.pdfUrl ?? null,
      created_by: p.createdBy ?? null,
    };

    const { data, error } = await supabase.from("care_plans").insert(row).select().limit(1);
    if (error) return res.status(500).json({ ok: false, error: "db_insert_failed", detail: error.message });
    return res.status(201).json({ ok: true, plan: data?.[0] || null });
  } catch (err) {
    console.error("Error in POST /clinic/plans:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/clinic/plans", async (req, res) => {
  try {
    const { userId, status = "active", limit = 20 } = req.query;
    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });

    let query = supabase.from("care_plans").select("*").eq("user_id", userId);
    if (status !== "all") query = query.eq("status", status);
    query = query.order("created_at", { ascending: false }).limit(parseInt(limit));

    const { data, error } = await query;
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, plans: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/clinic/plans/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("care_plans").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ ok: false, error: "plan_not_found" });
    return res.json({ ok: true, plan: data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch("/clinic/plans/:id", async (req, res) => {
  try {
    const updates = {};
    const allowed = ["title", "summary", "planBody", "goals", "startDate", "endDate", "status", "adherencePct", "pdfUrl"];
    const fieldMap = {
      planBody: "plan_body", startDate: "start_date", endDate: "end_date",
      adherencePct: "adherence_pct", pdfUrl: "pdf_url",
    };

    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[fieldMap[key] || key] = req.body[key];
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from("care_plans").update(updates).eq("id", req.params.id).select().single();
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, plan: data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /clinic/plans/:id/progress — Calculate plan adherence from wearable + check-in data
app.get("/clinic/plans/:id/progress", async (req, res) => {
  try {
    const { data: plan, error: planErr } = await supabase.from("care_plans").select("*").eq("id", req.params.id).single();
    if (planErr || !plan) return res.status(404).json({ ok: false, error: "plan_not_found" });

    const goals = plan.goals || [];
    const userId = plan.user_id;

    // Fetch latest daily snapshot for wearable data
    const { data: snapshots } = await supabase
      .from("daily_snapshots")
      .select("*")
      .eq("user_id", userId)
      .order("snapshot_date", { ascending: false })
      .limit(1);

    const latest = snapshots?.[0] || {};

    // Fetch latest clinic assessments for clinic-tracked goals
    const [latestGrip, latestVo2, latestBodyComp] = await Promise.all([
      supabase.from("grip_strength_assessments").select("*").eq("user_id", userId).order("measured_at", { ascending: false }).limit(1),
      supabase.from("vo2_assessments").select("*").eq("user_id", userId).order("measured_at", { ascending: false }).limit(1),
      supabase.from("tanita_assessments").select("*").eq("user_id", userId).order("measured_at", { ascending: false }).limit(1),
    ]);

    // Map metric names to current values
    const currentValues = {
      steps: latest.steps,
      sleep_total_minutes: latest.sleep_total_minutes,
      resting_hr: latest.resting_hr,
      hrv: latest.hrv,
      weight_kg: latest.weight_kg ?? latestBodyComp.data?.[0]?.weight_kg,
      body_fat_pct: latest.body_fat_percent ?? latestBodyComp.data?.[0]?.body_fat_pct,
      grip_right_kg: latestGrip.data?.[0]?.right_best,
      grip_left_kg: latestGrip.data?.[0]?.left_best,
      vo2_ml_kg_min: latestVo2.data?.[0]?.estimated_vo2_ml_kg_min,
      muscle_mass_kg: latestBodyComp.data?.[0]?.muscle_mass_kg,
    };

    const goalProgress = goals.map((g) => {
      const current = currentValues[g.metric] ?? null;
      const baseline = g.baseline;
      const target = g.target;
      let progressPct = null;

      if (current != null && baseline != null && target != null && target !== baseline) {
        progressPct = Math.round(((current - baseline) / (target - baseline)) * 100);
        progressPct = Math.max(0, Math.min(progressPct, 200)); // cap at 200%
      }

      return { ...g, current, progress_pct: progressPct };
    });

    const validGoals = goalProgress.filter((g) => g.progress_pct != null);
    const overallAdherence = validGoals.length > 0
      ? Math.round(validGoals.reduce((sum, g) => sum + g.progress_pct, 0) / validGoals.length)
      : null;

    return res.json({
      ok: true,
      plan_id: plan.id,
      plan_type: plan.plan_type,
      goals: goalProgress,
      overall_adherence_pct: overallAdherence,
      days_remaining: plan.end_date ? Math.max(0, Math.ceil((new Date(plan.end_date) - new Date()) / 86400000)) : null,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =======================================================
// SUPPLEMENT & MEDICATION TRACKING
// =======================================================

/**
 * GET /supplements - List active supplement protocols for a user
 * Query: userId (required), status (optional, default: "active"), limit (optional, default: 50)
 */
app.get("/supplements", async (req, res) => {
  try {
    const { userId, status = "active", limit = 50 } = req.query;
    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });

    let query = supabase.from("supplement_protocols").select("*").eq("user_id", userId);
    if (status !== "all") query = query.eq("active", status === "active");
    query = query.order("created_at", { ascending: false }).limit(parseInt(limit));

    const { data, error } = await query;
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, supplements: data || [] });
  } catch (err) {
    structuredLog("error_get_supplements", { error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /supplements - Create a new supplement protocol (provider use)
 * Body: { userId, name, dosage, unit, frequency, timesPerDay, scheduledTimes, instructions, category, prescribedBy, startDate, endDate }
 */
app.post("/supplements", async (req, res) => {
  try {
    const p = req.body || {};
    const { userId, name } = p;

    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });
    if (!name) return res.status(400).json({ ok: false, error: "name_required" });

    const row = {
      user_id: userId,
      name: name,
      dosage: p.dosage ?? null,
      unit: p.unit ?? null,
      frequency: p.frequency ?? "daily",
      times_per_day: p.timesPerDay ?? 1,
      scheduled_times: p.scheduledTimes ?? ["08:00"],
      instructions: p.instructions ?? null,
      category: p.category ?? "supplement",
      prescribed_by: p.prescribedBy ?? null,
      start_date: p.startDate ?? null,
      end_date: p.endDate ?? null,
      active: true,
    };

    const { data, error } = await supabase.from("supplement_protocols").insert(row).select().limit(1);
    if (error) return res.status(500).json({ ok: false, error: "db_insert_failed", detail: error.message });
    return res.status(201).json({ ok: true, supplement: data?.[0] || null });
  } catch (err) {
    structuredLog("error_post_supplements", { error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PUT /supplements/:id - Update a supplement protocol
 * Body: { name, dosage, unit, frequency, timesPerDay, scheduledTimes, instructions, category, prescribedBy, startDate, endDate, active }
 */
app.put("/supplements/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const p = req.body || {};

    const updates = {};
    const allowed = ["name", "dosage", "unit", "frequency", "timesPerDay", "scheduledTimes", "instructions", "category", "prescribedBy", "startDate", "endDate", "active"];
    const fieldMap = {
      timesPerDay: "times_per_day",
      scheduledTimes: "scheduled_times",
      prescribedBy: "prescribed_by",
      startDate: "start_date",
      endDate: "end_date",
    };

    for (const key of allowed) {
      if (p[key] !== undefined) updates[fieldMap[key] || key] = p[key];
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from("supplement_protocols").update(updates).eq("id", id).select().single();
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, supplement: data });
  } catch (err) {
    structuredLog("error_put_supplements", { error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /supplements/:id - Soft delete (set active=false)
 */
app.delete("/supplements/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from("supplement_protocols")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, supplement: data });
  } catch (err) {
    structuredLog("error_delete_supplements", { error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /supplements/log - Log a supplement as taken
 * Body: { userId, protocolId, dayKey, scheduledTime, status, notes }
 */
app.post("/supplements/log", async (req, res) => {
  try {
    const p = req.body || {};
    const { userId, protocolId, dayKey, scheduledTime } = p;

    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });
    if (!protocolId) return res.status(400).json({ ok: false, error: "protocolId_required" });
    if (!dayKey) return res.status(400).json({ ok: false, error: "dayKey_required" });

    const row = {
      user_id: userId,
      protocol_id: protocolId,
      taken_at: new Date().toISOString(),
      day_key: dayKey,
      scheduled_time: scheduledTime ?? null,
      status: p.status ?? "taken",
      notes: p.notes ?? null,
    };

    const { data, error } = await supabase
      .from("supplement_logs")
      .upsert(row, { onConflict: "user_id,protocol_id,day_key,scheduled_time" })
      .select()
      .limit(1);
    if (error) return res.status(500).json({ ok: false, error: "db_upsert_failed", detail: error.message });
    return res.json({ ok: true, log: data?.[0] || null });
  } catch (err) {
    structuredLog("error_post_supplement_log", { error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /supplements/log - Get supplement logs for a user in a date range
 * Query: userId (required), from (date), to (date), protocolId (optional), limit (default: 500)
 */
app.get("/supplements/log", async (req, res) => {
  try {
    const { userId, from, to, protocolId, limit = 500 } = req.query;

    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });

    let query = supabase.from("supplement_logs").select("*").eq("user_id", userId);

    if (protocolId) query = query.eq("protocol_id", protocolId);
    if (from) query = query.gte("day_key", from);
    if (to) query = query.lte("day_key", to);

    query = query.order("taken_at", { ascending: false }).limit(parseInt(limit));

    const { data, error } = await query;
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, logs: data || [] });
  } catch (err) {
    structuredLog("error_get_supplement_log", { error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /supplements/adherence - Get supplement adherence statistics
 * Query: userId (required), days (optional, default: 30)
 * Returns: adherence per supplement and overall adherence percentage
 */
app.get("/supplements/adherence", async (req, res) => {
  try {
    const { userId, days = 30 } = req.query;

    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });

    // Calculate date range
    const today = new Date();
    const startDate = new Date(today.getTime() - parseInt(days) * 24 * 60 * 60 * 1000);
    const fromKey = startDate.toISOString().split("T")[0]; // YYYY-MM-DD

    // Get active supplements
    const { data: supplements, error: suppErr } = await supabase
      .from("supplement_protocols")
      .select("id, name, dosage, unit, times_per_day")
      .eq("user_id", userId)
      .eq("active", true);
    if (suppErr) return res.status(500).json({ ok: false, error: suppErr.message });

    // Get logs in date range
    const { data: logs, error: logErr } = await supabase
      .from("supplement_logs")
      .select("*")
      .eq("user_id", userId)
      .gte("day_key", fromKey);
    if (logErr) return res.status(500).json({ ok: false, error: logErr.message });

    // Calculate adherence per supplement
    const adherenceBySupp = {};
    for (const supp of supplements) {
      const suppLogs = logs.filter((l) => l.protocol_id === supp.id);
      const expectedDoses = supp.times_per_day * parseInt(days); // Expected total doses
      const actualDoses = suppLogs.filter((l) => l.status === "taken").length;
      const percentage = expectedDoses > 0 ? Math.round((actualDoses / expectedDoses) * 100) : 0;

      adherenceBySupp[supp.id] = {
        id: supp.id,
        name: supp.name,
        dosage: supp.dosage,
        unit: supp.unit,
        timesPerDay: supp.times_per_day,
        expectedDoses,
        actualDoses,
        adherencePercentage: percentage,
      };
    }

    // Calculate overall adherence
    const totalExpected = Object.values(adherenceBySupp).reduce((sum, s) => sum + s.expectedDoses, 0);
    const totalActual = Object.values(adherenceBySupp).reduce((sum, s) => sum + s.actualDoses, 0);
    const overallAdherence = totalExpected > 0 ? Math.round((totalActual / totalExpected) * 100) : 0;

    return res.json({
      ok: true,
      userId,
      days: parseInt(days),
      dateRange: { from: fromKey, to: today.toISOString().split("T")[0] },
      adherenceBySupplements: Object.values(adherenceBySupp),
      overallAdherencePercentage: overallAdherence,
      totalExpectedDoses: totalExpected,
      totalActualDoses: totalActual,
    });
  } catch (err) {
    structuredLog("error_get_supplement_adherence", { error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /supplements/check-interactions
 * AI-powered interaction checker for user's active supplements
 * Query: userId (required)
 * Returns: array of interaction warnings with severity levels
 */
app.post("/supplements/check-interactions", async (req, res) => {
  try {
    const { userId } = req.body || req.query;

    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId_required" });
    }

    // Get all active supplements for user
    const { data: supplements, error: suppErr } = await supabase
      .from("supplement_protocols")
      .select("id, name, dosage, frequency, times_per_day")
      .eq("user_id", userId)
      .eq("active", true);

    if (suppErr) {
      return res.status(500).json({ ok: false, error: suppErr.message });
    }

    if (!supplements || supplements.length === 0) {
      return res.json({
        ok: true,
        userId,
        supplementCount: 0,
        interactions: [],
        message: "No active supplements to check",
      });
    }

    // Format supplements for Claude
    const supplementsForAnalysis = supplements.map(s => ({
      name: s.name,
      dosage: s.dosage || "unspecified",
      frequency: s.frequency || "daily",
    }));

    // Call Claude to check interactions
    const interactions = await checkSupplementInteractions(supplementsForAnalysis);

    // Transform interactions to include supplement IDs
    const enrichedInteractions = interactions.map(interaction => {
      // Find supplement IDs for those involved
      const involvedIds = supplements
        .filter(s => interaction.supplements_involved?.includes(s.name))
        .map(s => s.id);

      return {
        ...interaction,
        supplement_ids: involvedIds,
      };
    });

    // Cache results in database if there are interactions
    if (enrichedInteractions.length > 0) {
      for (const interaction of enrichedInteractions) {
        if (interaction.supplement_ids.length >= 2) {
          // Only cache interactions between multiple supplements
          const sortedIds = [...interaction.supplement_ids].sort();
          await supabase
            .from("supplement_interactions")
            .upsert(
              {
                user_id: userId,
                supplement_ids: sortedIds,
                severity: interaction.severity,
                summary: interaction.summary,
                details: interaction.details,
                checked_at: new Date().toISOString(),
              },
              { onConflict: "user_id,supplement_ids" }
            );
        }
      }
    }

    structuredLog("supplement_interactions_checked", {
      userId,
      supplementCount: supplements.length,
      interactionCount: enrichedInteractions.length,
    });

    return res.json({
      ok: true,
      userId,
      supplementCount: supplements.length,
      supplements: supplementsForAnalysis.map(s => s.name),
      interactions: enrichedInteractions,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Error in POST /supplements/check-interactions:", err);
    structuredLog("error_supplement_interactions", { error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =======================================================
// CLINICIAN BULK INTAKE (submit entire testing day at once)
// =======================================================
app.post("/clinician/intake", async (req, res) => {
  try {
    const p = req.body || {};
    const { userId, sessionDate, clinicianId } = p;

    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });
    if (!sessionDate) return res.status(400).json({ ok: false, error: "sessionDate_required" });

    // 1. Create the testing session
    const { data: sessionData, error: sessionErr } = await supabase
      .from("testing_sessions")
      .insert({
        user_id: userId,
        session_date: sessionDate,
        clinician_id: clinicianId ?? null,
        session_type: p.sessionType ?? "initial",
        status: "completed",
        notes: p.notes ?? null,
        hr_recovery_best: p.hrRecoveryBest ?? null,
        cardio_fitness_category: p.cardioFitnessCategory ?? null,
        strength_power_category: p.strengthPowerCategory ?? null,
        autonomic_balance_category: p.autonomicBalanceCategory ?? null,
        frailty_risk: p.frailtyRisk ?? null,
        longevity_risk_tier: p.longevityRiskTier ?? null,
        personalized_plan_summary: p.personalizedPlanSummary ?? null,
      })
      .select()
      .single();

    if (sessionErr) return res.status(500).json({ ok: false, error: "session_create_failed", detail: sessionErr.message });
    const sessionId = sessionData.id;
    const results = { session: sessionData };

    const tsIso = new Date(sessionDate).toISOString();
    const dk = sessionDate; // Already YYYY-MM-DD

    // 2. Insert resting vitals (office measurements) if provided
    if (p.restingVitals) {
      const rv = p.restingVitals;
      const { data, error } = await supabase.from("office_measurements").insert({
        user_id: userId, session_id: sessionId, measured_at: tsIso, day_key: dk,
        bp_systolic: rv.bpSystolic ?? null, bp_diastolic: rv.bpDiastolic ?? null,
        weight_kg: rv.weightKg ?? null, body_fat_pct: rv.bodyFatPct ?? null,
        resting_hr: rv.restingHr ?? null, spo2_pct: rv.spo2Pct ?? null,
        rpe_baseline: rv.rpeBaseline ?? null, height_cm: rv.heightCm ?? null,
        device: "Manual", raw_json: rv,
      }).select("id").limit(1);
      results.resting_vitals = data?.[0] || { error: error?.message };
    }

    // 3. Insert CONNEQT HRV if provided
    if (p.conneqt) {
      const c = p.conneqt;
      const { data, error } = await supabase.from("conneqt_assessments").insert({
        user_id: userId, session_id: sessionId, measured_at: tsIso, day_key: dk,
        source: "CONNEQT", device: c.device ?? "CONNEQT Pulse",
        brachial_systolic: c.brachialSystolic ?? null, brachial_diastolic: c.brachialDiastolic ?? null,
        central_systolic: c.centralSystolic ?? null, central_diastolic: c.centralDiastolic ?? null,
        heart_rate: c.heartRate ?? null,
        augmentation_index: c.augmentationIndex ?? null, augmentation_pressure: c.augmentationPressure ?? null,
        pulse_pressure_amplification: c.pulsePressureAmplification ?? null,
        sevr: c.sevr ?? null, central_pulse_pressure: c.centralPulsePressure ?? null,
        arterial_age: c.arterialAge ?? null,
        recording_duration_min: c.recordingDurationMin ?? null,
        hrv_ms: c.hrvMs ?? null, rmssd: c.rmssd ?? null,
        stress_index: c.stressIndex ?? null, signal_quality: c.signalQuality ?? null,
        cv_risk_zone: c.cvRiskZone ?? null,
        central_bp_classification: c.centralBpClassification ?? null,
        brachial_bp_classification: c.brachialBpClassification ?? null,
        ppa_classification: c.ppaClassification ?? null,
        aug_pressure_classification: c.augPressureClassification ?? null,
        aug_index_classification: c.augIndexClassification ?? null,
        sevr_classification: c.sevrClassification ?? null,
        report_pdf_url: c.reportPdfUrl ?? null, report_date: c.reportDate ?? null,
        raw_json: c,
      }).select("id").limit(1);
      results.conneqt = data?.[0] || { error: error?.message };
    }

    // 4. Insert grip strength if provided
    if (p.gripStrength) {
      const g = p.gripStrength;
      const { data, error } = await supabase.from("grip_strength_assessments").insert({
        user_id: userId, session_id: sessionId, measured_at: tsIso, day_key: dk,
        source: "JAMAR", device: g.device ?? "Jamar", unit: g.unit ?? "kgf",
        left_best: g.leftBest ?? null, right_best: g.rightBest ?? null,
        left_attempts: g.leftAttempts ?? null, right_attempts: g.rightAttempts ?? null,
        dominant_hand: g.dominantHand ?? null, grip_to_bw_ratio: g.gripToBwRatio ?? null,
        percentile_age_sex: g.percentileAgeSex ?? null, notes: g.notes ?? null,
        raw_json: g,
      }).select("id").limit(1);
      results.grip_strength = data?.[0] || { error: error?.message };
    }

    // 5. Insert functional tests if provided
    if (p.sitToStand) {
      const s = p.sitToStand;
      const { data, error } = await supabase.from("functional_assessments").insert({
        user_id: userId, session_id: sessionId, test_type: "sit_to_stand",
        measured_at: tsIso, day_key: dk,
        sts_time_seconds: s.timeSeconds ?? null, sts_hands_used: s.handsUsed ?? null,
        sts_balance_loss: s.balanceLoss ?? null, sts_immediate_hr: s.immediateHr ?? null,
        sts_chair_height_cm: s.chairHeightCm ?? null,
        percentile_age_sex: s.percentileAgeSex ?? null,
        interpretation: s.interpretation ?? null, notes: s.notes ?? null, raw_json: s,
      }).select("id").limit(1);
      results.sit_to_stand = data?.[0] || { error: error?.message };
    }

    if (p.gaitSpeed) {
      const g = p.gaitSpeed;
      const { data, error } = await supabase.from("functional_assessments").insert({
        user_id: userId, session_id: sessionId, test_type: "gait_speed",
        measured_at: tsIso, day_key: dk,
        gait_time_seconds: g.timeSeconds ?? null, gait_speed_ms: g.speedMs ?? null,
        gait_assistive_device: g.assistiveDevice ?? null, gait_interpretation: g.interpretation ?? null,
        percentile_age_sex: g.percentileAgeSex ?? null, notes: g.notes ?? null, raw_json: g,
      }).select("id").limit(1);
      results.gait_speed = data?.[0] || { error: error?.message };
    }

    if (p.sixMinWalk) {
      const w = p.sixMinWalk;
      const { data, error } = await supabase.from("functional_assessments").insert({
        user_id: userId, session_id: sessionId, test_type: "six_min_walk",
        measured_at: tsIso, day_key: dk,
        walk_distance_meters: w.distanceMeters ?? null, walk_percent_predicted: w.percentPredicted ?? null,
        walk_peak_hr: w.peakHr ?? null, walk_recovery_hr_1min: w.recoveryHr1min ?? null,
        walk_post_rpe: w.postRpe ?? null, walk_symptoms: w.symptoms ?? null,
        percentile_age_sex: w.percentileAgeSex ?? null, notes: w.notes ?? null, raw_json: w,
      }).select("id").limit(1);
      results.six_min_walk = data?.[0] || { error: error?.message };
    }

    // 6. Insert VO2 bike test if provided
    if (p.vo2) {
      const v = p.vo2;
      const { data, error } = await supabase.from("vo2_assessments").insert({
        user_id: userId, session_id: sessionId, measured_at: tsIso, day_key: dk,
        protocol: v.protocol ?? "precor_watt",
        final_workload_watts: v.finalWorkloadWatts ?? null,
        minute_2_hr: v.minute2Hr ?? null, minute_3_hr: v.minute3Hr ?? null,
        kgm_per_min: v.kgmPerMin ?? null,
        estimated_vo2_ml_kg_min: v.estimatedVo2MlKgMin ?? null,
        age_adjusted_interpretation: v.ageAdjustedInterpretation ?? null,
        hr_recovery_1min: v.hrRecovery1min ?? null, hr_recovery_best: v.hrRecoveryBest ?? null,
        cardio_fitness_category: v.cardioFitnessCategory ?? null,
        notes: v.notes ?? null, raw_json: v,
      }).select("id").limit(1);
      results.vo2 = data?.[0] || { error: error?.message };
    }

    // 7. Insert body composition if provided
    if (p.bodyComposition) {
      const b = p.bodyComposition;
      const { data, error } = await supabase.from("tanita_assessments").insert({
        user_id: userId, session_id: sessionId, measured_at: tsIso, day_key: dk,
        source: b.source ?? "CHARDER", device: b.device ?? "Charder MA601",
        weight_kg: b.weightKg ?? null, body_fat_pct: b.bodyFatPct ?? null,
        fat_mass_kg: b.fatMassKg ?? null, fat_free_mass_kg: b.fatFreeMassKg ?? null,
        muscle_mass_kg: b.muscleMassKg ?? null, tbw_pct: b.tbwPct ?? null, tbw_kg: b.tbwKg ?? null,
        visceral_fat_rating: b.visceralFatRating ?? null, bmr_kcal: b.bmrKcal ?? null,
        metabolic_age: b.metabolicAge ?? null,
        // Charder-specific
        icw_lbs: b.icwLbs ?? null, ecw_lbs: b.ecwLbs ?? null,
        protein_lbs: b.proteinLbs ?? null, mineral_lbs: b.mineralLbs ?? null,
        slm_lbs: b.slmLbs ?? null, smm_lbs: b.smmLbs ?? null,
        phase_angle_deg: b.phaseAngleDeg ?? null, ffm_index: b.ffmIndex ?? null,
        smi: b.smi ?? null, asmi: b.asmi ?? null, bmi: b.bmi ?? null,
        vfa_rating: b.vfaRating ?? null, total_energy_expenditure: b.totalEnergyExpenditure ?? null,
        health_score: b.healthScore ?? null, muscle_quality_score: b.muscleQualityScore ?? null,
        target_weight_lbs: b.targetWeightLbs ?? null,
        weight_control_lbs: b.weightControlLbs ?? null,
        fat_control_lbs: b.fatControlLbs ?? null,
        muscle_control_lbs: b.muscleControlLbs ?? null,
        segmental_lean: b.segmentalLean ?? null, segmental_fat: b.segmentalFat ?? null,
        body_balance: b.bodyBalance ?? null, impedance_data: b.impedanceData ?? null,
        grip_right_n: b.gripRightN ?? null, grip_left_n: b.gripLeftN ?? null,
        grip_right_lbf: b.gripRightLbf ?? null, grip_left_lbf: b.gripLeftLbf ?? null,
        raw_json: b,
      }).select("id").limit(1);
      results.body_composition = data?.[0] || { error: error?.message };
    }

    // 8. Insert lab results if provided
    if (p.labs) {
      const l = p.labs;
      const { data, error } = await supabase.from("lab_results").insert({
        user_id: userId, session_id: sessionId, collected_at: tsIso, day_key: dk,
        lab_name: l.labName ?? null,
        hba1c_pct: l.hba1cPct ?? null, fasting_glucose_mg_dl: l.fastingGlucoseMgDl ?? null,
        insulin_uiu_ml: l.insulinUiuMl ?? null, homa_ir: l.homaIr ?? null,
        total_cholesterol: l.totalCholesterol ?? null, ldl_cholesterol: l.ldlCholesterol ?? null,
        hdl_cholesterol: l.hdlCholesterol ?? null, triglycerides: l.triglycerides ?? null,
        apob_mg_dl: l.apobMgDl ?? null, lpa_nmol_l: l.lpaNmolL ?? null,
        hs_crp_mg_l: l.hsCrpMgL ?? null, homocysteine_umol_l: l.homocysteineUmolL ?? null,
        testosterone_ng_dl: l.testosteroneNgDl ?? null, free_testosterone: l.freeTestosterone ?? null,
        dhea_s: l.dheaS ?? null, cortisol_am: l.cortisolAm ?? null,
        tsh: l.tsh ?? null, vitamin_d_ng_ml: l.vitaminDNgMl ?? null,
        additional_results: l.additionalResults ?? null,
        report_pdf_url: l.reportPdfUrl ?? null, notes: l.notes ?? null, raw_json: l,
      }).select("id").limit(1);
      results.labs = data?.[0] || { error: error?.message };
    }

    return res.status(201).json({ ok: true, results });
  } catch (err) {
    console.error("Error in POST /clinician/intake:", err);
    return res.status(500).json({ ok: false, error: "internal_error", detail: err.message });
  }
});

// GET /clinician/patient/:userId/timeline — Full patient timeline
app.get("/clinician/patient/:userId/timeline", async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 10 } = req.query;

    const [sessions, plans, snapshots] = await Promise.all([
      supabase.from("testing_sessions").select("*").eq("user_id", userId).order("session_date", { ascending: false }).limit(parseInt(limit)),
      supabase.from("care_plans").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(parseInt(limit)),
      supabase.from("daily_snapshots").select("day_key,steps,resting_hr,hrv,sleep_total_minutes,vo2_max").eq("user_id", userId).order("snapshot_date", { ascending: false }).limit(90),
    ]);

    return res.json({
      ok: true,
      sessions: sessions.data || [],
      plans: plans.data || [],
      recent_snapshots: snapshots.data || [],
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =======================================================
// BIOLOGICAL AGE CALCULATION SERVICE
// =======================================================

/**
 * Helper: Collect latest biomarkers for a user
 * Searches daily_snapshots + clinic tables for most recent available metrics
 */
async function gatherLatestBiomarkers(supabase, userId) {
  // Fetch latest daily snapshot
  const { data: snapshots } = await supabase
    .from("daily_snapshots")
    .select("*")
    .eq("user_id", userId)
    .order("snapshot_date", { ascending: false })
    .limit(1);

  const snapshot = snapshots?.[0] || {};

  // Fetch latest clinic labs
  const { data: labsArray } = await supabase
    .from("lab_results")
    .select("*")
    .eq("user_id", userId)
    .order("collected_at", { ascending: false })
    .limit(1);

  const labs = labsArray?.[0] || {};

  // Fetch latest functional assessments
  const { data: gripArray } = await supabase
    .from("grip_strength_assessments")
    .select("*")
    .eq("user_id", userId)
    .order("measured_at", { ascending: false })
    .limit(1);

  const grip = gripArray?.[0] || {};

  const { data: gaitArray } = await supabase
    .from("functional_assessments")
    .select("*")
    .eq("user_id", userId)
    .eq("test_type", "gait_speed")
    .order("measured_at", { ascending: false })
    .limit(1);

  const gait = gaitArray?.[0] || {};

  // Fetch latest VO2 assessment
  const { data: vo2Array } = await supabase
    .from("vo2_assessments")
    .select("*")
    .eq("user_id", userId)
    .order("measured_at", { ascending: false })
    .limit(1);

  const vo2 = vo2Array?.[0] || {};

  // Fetch latest tanita body composition
  const { data: tanitaArray } = await supabase
    .from("tanita_assessments")
    .select("*")
    .eq("user_id", userId)
    .order("measured_at", { ascending: false })
    .limit(1);

  const tanita = tanitaArray?.[0] || {};

  // Fetch user profile for DOB/age/sex
  // For now, we'll return the data and let caller provide chronological age
  return {
    snapshot,
    labs,
    grip,
    gait,
    vo2,
    tanita,
  };
}

/**
 * GET /biological-age?userId={UUID}
 * Compute and return latest biological age using most recent available data
 */
app.get("/biological-age", async (req, res) => {
  try {
    const userId = getAppUserIdFromAny(req.query);
    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "missing_or_invalid_userId",
        message: "Provide a valid userId (UUID) as query param",
      });
    }

    const { chronologicalAge, sex } = req.query;
    if (!chronologicalAge || !sex) {
      return res.status(400).json({
        ok: false,
        error: "missing_params",
        message: "Provide chronologicalAge and sex query params",
      });
    }

    const age = parseInt(chronologicalAge);
    if (isNaN(age) || age < 18) {
      return res.status(400).json({
        ok: false,
        error: "invalid_age",
        message: "chronologicalAge must be a number >= 18",
      });
    }

    // Gather latest biomarkers
    const biomarkers = await gatherLatestBiomarkers(supabase, userId);

    // Build wearable metrics object
    const wearableMetrics = {
      vo2_max: biomarkers.snapshot.vo2_max ?? biomarkers.vo2.estimated_vo2_ml_kg_min ?? null,
      hrv: biomarkers.snapshot.hrv ?? null,
      resting_hr: biomarkers.snapshot.resting_hr ?? null,
      sleep_total_minutes: biomarkers.snapshot.sleep_total_minutes ?? null,
      steps: biomarkers.snapshot.steps ?? null,
      respiratory_rate: biomarkers.snapshot.respiratory_rate ?? null,
      weight_kg: biomarkers.snapshot.weight_kg ?? biomarkers.tanita.weight_kg ?? null,
      height_m: null, // Not stored; fallback in computeBiologicalAge
      body_fat_percent: biomarkers.snapshot.body_fat_percent ?? biomarkers.tanita.body_fat_pct ?? null,
      bp_systolic: biomarkers.snapshot.bp_systolic ?? null,
      bp_diastolic: biomarkers.snapshot.bp_diastolic ?? null,
    };

    // Build clinic labs object
    const clinicLabs = {
      hs_crp_mg_l: biomarkers.labs.hs_crp_mg_l ?? null,
      total_cholesterol: biomarkers.labs.total_cholesterol ?? null,
      hdl_cholesterol: biomarkers.labs.hdl_cholesterol ?? null,
      ldl_cholesterol: biomarkers.labs.ldl_cholesterol ?? null,
      triglycerides: biomarkers.labs.triglycerides ?? null,
      fasting_glucose_mg_dl: biomarkers.labs.fasting_glucose_mg_dl ?? null,
      hba1c_pct: biomarkers.labs.hba1c_pct ?? null,
      bp_systolic: null, // Use wearable if available
      bp_diastolic: null,
      body_fat_pct: biomarkers.tanita.body_fat_pct ?? null,
      grip_strength: null, // See functional assessments
    };

    // Build functional assessments object
    const functionalAssessments = {
      grip_strength: biomarkers.grip.right_best ?? biomarkers.grip.left_best ?? null,
      gait_speed_ms: biomarkers.gait.gait_speed_ms ?? null,
      sit_to_stand_seconds: null,
      six_min_walk_distance_m: null,
    };

    // Compute biological age
    const result = computeBiologicalAge({
      chronologicalAge: age,
      sex,
      wearableMetrics,
      clinicLabs,
      functionalAssessments,
    });

    // Store in database
    const { error: insertError } = await supabase
      .from("biological_age_history")
      .insert({
        user_id: userId,
        chronological_age: age,
        biological_age: result.biologicalAge,
        age_delta: result.ageDelta,
        confidence: result.confidence,
        breakdown: result.breakdown,
        input_data: {
          wearableMetrics,
          clinicLabs,
          functionalAssessments,
        },
      });

    if (insertError) {
      // Log but don't fail the response
      structuredLog("biological_age_insert_error", {
        userId,
        error: insertError.message,
      });
    }

    structuredLog("biological_age_computed", {
      userId,
      chronologicalAge: age,
      biologicalAge: result.biologicalAge,
      ageDelta: result.ageDelta,
      confidence: result.confidence,
      metricsCount: result.metricsCount,
    });

    return res.json({
      ok: true,
      biologicalAge: result,
    });
  } catch (err) {
    structuredLog("biological_age_exception", {
      userId: getAppUserIdFromAny(req.query),
      error: err.message,
    });
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      message: err.message,
    });
  }
});

/**
 * GET /biological-age/history?userId={UUID}&months=12
 * Return biological age computations over time (monthly aggregation)
 */
app.get("/biological-age/history", async (req, res) => {
  try {
    const userId = getAppUserIdFromAny(req.query);
    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "missing_or_invalid_userId",
        message: "Provide a valid userId (UUID) as query param",
      });
    }

    const months = Math.min(Math.max(parseInt(req.query.months) || 12, 1), 120);
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - months);

    const { data, error } = await supabase
      .from("biological_age_history")
      .select("*")
      .eq("user_id", userId)
      .gte("computed_at", cutoffDate.toISOString())
      .order("computed_at", { ascending: true });

    if (error) {
      return res.status(500).json({
        ok: false,
        error: "db_query_failed",
        message: error.message,
      });
    }

    // Aggregate by month: pick one record per month (the latest one)
    const byMonth = new Map();
    for (const record of data || []) {
      const date = new Date(record.computed_at);
      const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

      if (!byMonth.has(monthKey) || new Date(record.computed_at) > new Date(byMonth.get(monthKey).computed_at)) {
        byMonth.set(monthKey, record);
      }
    }

    const history = Array.from(byMonth.values()).sort(
      (a, b) => new Date(a.computed_at) - new Date(b.computed_at)
    );

    return res.json({
      ok: true,
      userId,
      months,
      recordCount: history.length,
      history,
    });
  } catch (err) {
    structuredLog("biological_age_history_exception", {
      userId: getAppUserIdFromAny(req.query),
      error: err.message,
    });
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      message: err.message,
    });
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
// IMAGE ASSETS (served for iOS app)
// -------------------------------------------------------
app.use(
  "/assets/images",
  express.static(path.join(__dirname, "assets", "images", "web"), {
    maxAge: "7d",
    immutable: true,
  })
);
app.use(
  "/assets/images/ios",
  express.static(path.join(__dirname, "assets", "images", "ios"), {
    maxAge: "7d",
    immutable: true,
  })
);

// Image manifest — returns all available app images with URLs
app.get("/api/images", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const images = {
    onboarding_welcome: {
      feature: "Onboarding Welcome",
      web: `${baseUrl}/assets/images/onboarding-welcome.jpg`,
      ios_1x: `${baseUrl}/assets/images/ios/onboarding-welcome@1x.jpg`,
      ios_2x: `${baseUrl}/assets/images/ios/onboarding-welcome@2x.jpg`,
      ios_3x: `${baseUrl}/assets/images/ios/onboarding-welcome@3x.jpg`,
    },
    home_today: {
      feature: "Home / Today Tab",
      web: `${baseUrl}/assets/images/home-today.jpg`,
      ios_1x: `${baseUrl}/assets/images/ios/home-today@1x.jpg`,
      ios_2x: `${baseUrl}/assets/images/ios/home-today@2x.jpg`,
      ios_3x: `${baseUrl}/assets/images/ios/home-today@3x.jpg`,
    },
    sleep_tracking: {
      feature: "Sleep / History Tab",
      web: `${baseUrl}/assets/images/sleep-tracking.jpg`,
      ios_1x: `${baseUrl}/assets/images/ios/sleep-tracking@1x.jpg`,
      ios_2x: `${baseUrl}/assets/images/ios/sleep-tracking@2x.jpg`,
      ios_3x: `${baseUrl}/assets/images/ios/sleep-tracking@3x.jpg`,
    },
    meditation_breathing: {
      feature: "Meditation / Breathing",
      web: `${baseUrl}/assets/images/meditation-breathing.jpg`,
      ios_1x: `${baseUrl}/assets/images/ios/meditation-breathing@1x.jpg`,
      ios_2x: `${baseUrl}/assets/images/ios/meditation-breathing@2x.jpg`,
      ios_3x: `${baseUrl}/assets/images/ios/meditation-breathing@3x.jpg`,
    },
    learn_tab: {
      feature: "Learn Tab",
      web: `${baseUrl}/assets/images/learn-tab.jpg`,
      ios_1x: `${baseUrl}/assets/images/ios/learn-tab@1x.jpg`,
      ios_2x: `${baseUrl}/assets/images/ios/learn-tab@2x.jpg`,
      ios_3x: `${baseUrl}/assets/images/ios/learn-tab@3x.jpg`,
    },
    morning_checkin: {
      feature: "Morning Check-in",
      web: `${baseUrl}/assets/images/morning-checkin.jpg`,
      ios_1x: `${baseUrl}/assets/images/ios/morning-checkin@1x.jpg`,
      ios_2x: `${baseUrl}/assets/images/ios/morning-checkin@2x.jpg`,
      ios_3x: `${baseUrl}/assets/images/ios/morning-checkin@3x.jpg`,
    },
    streaks_badges: {
      feature: "Streaks / Badges",
      web: `${baseUrl}/assets/images/streaks-badges.jpg`,
      ios_1x: `${baseUrl}/assets/images/ios/streaks-badges@1x.jpg`,
      ios_2x: `${baseUrl}/assets/images/ios/streaks-badges@2x.jpg`,
      ios_3x: `${baseUrl}/assets/images/ios/streaks-badges@3x.jpg`,
    },
    weekly_challenges: {
      feature: "Weekly Challenges",
      web: `${baseUrl}/assets/images/weekly-challenges.jpg`,
      ios_1x: `${baseUrl}/assets/images/ios/weekly-challenges@1x.jpg`,
      ios_2x: `${baseUrl}/assets/images/ios/weekly-challenges@2x.jpg`,
      ios_3x: `${baseUrl}/assets/images/ios/weekly-challenges@3x.jpg`,
    },
    personalized_insights: {
      feature: "Personalized Insights",
      web: `${baseUrl}/assets/images/personalized-insights.jpg`,
      ios_1x: `${baseUrl}/assets/images/ios/personalized-insights@1x.jpg`,
      ios_2x: `${baseUrl}/assets/images/ios/personalized-insights@2x.jpg`,
      ios_3x: `${baseUrl}/assets/images/ios/personalized-insights@3x.jpg`,
    },
    clinician_dashboard: {
      feature: "Clinician Dashboard",
      web: `${baseUrl}/assets/images/clinician-dashboard.jpg`,
      ios_1x: `${baseUrl}/assets/images/ios/clinician-dashboard@1x.jpg`,
      ios_2x: `${baseUrl}/assets/images/ios/clinician-dashboard@2x.jpg`,
      ios_3x: `${baseUrl}/assets/images/ios/clinician-dashboard@3x.jpg`,
    },
    nutrition_wellness: {
      feature: "Nutrition / Wellness",
      web: `${baseUrl}/assets/images/nutrition-wellness.jpg`,
      ios_1x: `${baseUrl}/assets/images/ios/nutrition-wellness@1x.jpg`,
      ios_2x: `${baseUrl}/assets/images/ios/nutrition-wellness@2x.jpg`,
      ios_3x: `${baseUrl}/assets/images/ios/nutrition-wellness@3x.jpg`,
    },
  };
  res.json({ images });
});

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

// -------------------------------------------------------
// PROVIDER PORTAL SPA
// -------------------------------------------------------
app.use(
  "/provider",
  express.static(path.join(__dirname, "public", "provider"))
);
app.get(/^\/provider(\/.*)?$/, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "provider", "index.html"));
});

// --- Start server ---
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, async () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);

  // Initialize cron jobs for morning readiness notifications
  const cronStarted = await startCronJobs(supabase, { sendPush });
  if (cronStarted) {
    console.log("✓ Morning readiness notification cron initialized");
  }
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully...");
  stopCronJobs();
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
