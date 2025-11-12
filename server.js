// server.js
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const { sendPush } = require("./apns");

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json({ limit: "1mb" }));

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Health
app.get("/", (_req, res) => res.send("Vitaliage Push API ✅"));
app.get("/ping", (_req, res) => res.json({ ok: true }));

// DB connectivity
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

// UPSERT device
app.post("/devices", async (req, res) => {
  const { userId, platform = "ios", token } = req.body || {};
  if (!token) return res.status(400).json({ error: "Missing token" });

  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

// --- Push handler + routes
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

// Debug: list routes
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});

