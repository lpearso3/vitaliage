// apns.js
// Minimal APNs sender over HTTP/2 with JWT
const http2 = require("http2");
const jwt = require("jsonwebtoken");

// Required env:
// APNS_TEAM_ID, APNS_KEY_ID, APNS_BUNDLE_ID, APNS_ENV (sandbox|production), APNS_KEY_B64
const TEAM_ID = process.env.APNS_TEAM_ID;
const KEY_ID = process.env.APNS_KEY_ID;
const BUNDLE_ID = process.env.APNS_BUNDLE_ID;
const ENV = (process.env.APNS_ENV || "sandbox").toLowerCase();
const KEY_B64 = process.env.APNS_KEY_B64;

if (!TEAM_ID || !KEY_ID || !BUNDLE_ID || !KEY_B64) {
  console.warn(
    "[APNS] Missing one or more required env vars: APNS_TEAM_ID, APNS_KEY_ID, APNS_BUNDLE_ID, APNS_KEY_B64"
  );
}

// Build ES256 JWT for APNs
function makeBearer() {
  const keyPem = Buffer.from(KEY_B64, "base64").toString("utf8");
  return jwt.sign(
    { iss: TEAM_ID, iat: Math.floor(Date.now() / 1000) },
    keyPem,
    { algorithm: "ES256", header: { alg: "ES256", kid: KEY_ID } }
  );
}

function hostForEnv() {
  return ENV === "production"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
}

/**
 * sendPush
 * @param {string} deviceToken
 * @param {{title?:string, body?:string, data?:object}} payload
 * @param {{pushType?:'alert'|'background', priority?:5|10, collapseId?:string}} opts
 * @returns {Promise<{status:number, body?:string, headers?:object}>}
 */
async function sendPush(deviceToken, payload = {}, opts = {}) {
  const pushType = (opts.pushType || "alert").toLowerCase(); // 'alert' or 'background'
  const isBackground = pushType === "background";
  const priority = opts.priority ?? (isBackground ? 5 : 10); // 10 = immediate (alert), 5 = background
  const bearer = makeBearer();
  const host = hostForEnv();

  // Build APNs JSON
  let body;
  if (isBackground) {
    body = {
      aps: { "content-available": 1 },
      ...(payload.data ? { data: payload.data } : {}),
    };
  } else {
    body = {
      aps: {
        alert: {
          title: payload.title || "",
          body: payload.body || "",
        },
        sound: "default",
      },
      ...(payload.data ? { data: payload.data } : {}),
    };
  }

  const path = `/3/device/${deviceToken}`;
  const client = http2.connect(host);

  const headers = {
    ":method": "POST",
    ":path": path,
    authorization: `bearer ${bearer}`,
    "apns-topic": BUNDLE_ID,
    "apns-push-type": isBackground ? "background" : "alert",
    "apns-priority": String(priority),
  };
  if (opts.collapseId) headers["apns-collapse-id"] = opts.collapseId;

  return new Promise((resolve, reject) => {
    const req = client.request(headers);
    let resp = "";
    req.setEncoding("utf8");

    req.on("response", (h) => {
      // Capture headers (http2 pseudo headers included)
      req.on("data", (chunk) => (resp += chunk));
      req.on("end", () => {
        client.close();
        const status = Number(h[":status"]) || 0;
        resolve({ status, body: resp || "", headers: h });
      });
    });

    req.on("error", (err) => {
      client.close();
      reject(err);
    });

    req.end(JSON.stringify(body));
  });
}

module.exports = { sendPush };

