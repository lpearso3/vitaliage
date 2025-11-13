// apns.js
const http2 = require("http2");
const jwt = require("jsonwebtoken");

// Required environment variables
const APNS_KEY_ID = process.env.APNS_KEY_ID;        // e.g. "55KBB26SX8"
const APNS_TEAM_ID = process.env.APNS_TEAM_ID;      // e.g. "HT57Y848P"
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID;  // e.g. "com.vitaliage"
const APNS_ENV =
  process.env.APNS_ENV === "production"
    ? "api.push.apple.com"
    : "api.sandbox.push.apple.com"; // default = sandbox

// Read the PEM directly from APNS_KEY_P8
// If Render stores it with \n in one line, this converts them to real newlines.
let APNS_KEY_PEM = process.env.APNS_KEY_P8 || "";
APNS_KEY_PEM = APNS_KEY_PEM.replace(/\\n/g, "\n");

if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_BUNDLE_ID) {
  throw new Error("APNS_KEY_ID, APNS_TEAM_ID, and APNS_BUNDLE_ID must be set");
}

if (!APNS_KEY_PEM || !APNS_KEY_PEM.includes("BEGIN PRIVATE KEY")) {
  throw new Error("APNS_KEY_P8 is missing or not a valid PEM private key");
}

// Create JWT for APNs auth
function createJwt() {
  return jwt.sign(
    {},
    APNS_KEY_PEM,
    {
      algorithm: "ES256",
      issuer: APNS_TEAM_ID,
      header: {
        alg: "ES256",
        kid: APNS_KEY_ID,
      },
      expiresIn: "1h",
    }
  );
}

/**
 * Send a push notification via APNs
 * @param {string} deviceToken
 * @param {{title?: string, body?: string, data?: object}} payload
 * @param {{pushType?: 'alert' | 'background', priority?: 5 | 10, collapseId?: string}} options
 * @returns {Promise<{status:number, body:any, headers:object}>}
 */
function sendPush(deviceToken, payload = {}, options = {}) {
  const {
    pushType = "alert",   // "alert" or "background"
    priority,
    collapseId,
  } = options;

  const jwtToken = createJwt();
  const client = http2.connect(`https://${APNS_ENV}`);

  const requestHeaders = {
    ":method": "POST",
    ":path": `/3/device/${deviceToken}`,
    authorization: `bearer ${jwtToken}`,
    "apns-topic": APNS_BUNDLE_ID,
    "apns-push-type": pushType,
    "content-type": "application/json",
  };

  // Priority: 10 = immediate (alert), 5 = background
  if (priority != null) {
    requestHeaders["apns-priority"] = String(priority);
  } else {
    requestHeaders["apns-priority"] = pushType === "background" ? "5" : "10";
  }

  if (collapseId) {
    requestHeaders["apns-collapse-id"] = collapseId;
  }

  // Build APNs payload
  const isBackground = pushType === "background";

  const notification = isBackground
    ? {
        aps: {
          "content-available": 1,
        },
        ...(payload.data ? { data: payload.data } : {}),
      }
    : {
        aps: {
          alert:
            payload.title || payload.body
              ? {
                  title: payload.title || undefined,
                  body: payload.body || undefined,
                }
              : undefined,
          sound: "default",
        },
        ...(payload.data ? { data: payload.data } : {}),
      };

  return new Promise((resolve, reject) => {
    const req = client.request(requestHeaders);

    let responseData = "";
    let statusCode = 0;
    let responseHeaders = {};

    req.on("response", (headers) => {
      statusCode = Number(headers[":status"] || 0);
      responseHeaders = headers;
    });

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      responseData += chunk;
    });

    req.on("end", () => {
      client.close();
      let body = null;
      if (responseData) {
        try {
          body = JSON.parse(responseData);
        } catch (_) {
          body = responseData;
        }
      }
      resolve({
        status: statusCode,
        headers: responseHeaders,
        body,
      });
    });

    req.on("error", (err) => {
      client.close();
      reject(err);
    });

    req.write(JSON.stringify(notification));
    req.end();
  });
}

module.exports = { sendPush };
