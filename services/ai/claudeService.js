/**
 * Claude AI Service for Vitaliage
 *
 * Uses the Anthropic Messages API directly (no SDK required).
 * Provides:
 *   - generateDailySummary(bundle)  → one-shot summary string
 *   - streamChatResponse(bundle, messages, onChunk) → streamed chat
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5-20250929";
const ANTHROPIC_VERSION = "2023-06-01";

function getApiKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === "your-anthropic-api-key-here") {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  return key;
}

// ── System Prompt ──────────────────────────────────────────────

const SYSTEM_PROMPT_SUMMARY = `You are a health and wellness coach for a regenerative medicine clinic called Metamorphosis Wellness.

You are generating a brief daily health summary for a patient based on their wearable and clinic data from the past 28 days.

Guidelines:
- Be warm, encouraging, and specific to their actual numbers
- Reference concrete trends (e.g. "your HRV improved 15% this month")
- Never diagnose conditions or prescribe treatments
- If something looks concerning, suggest they discuss it with their care team
- Focus on actionable lifestyle advice: sleep, movement, recovery, stress management
- Keep the summary to 3-4 sentences — concise and motivating
- Use plain language, not medical jargon
- Address the patient directly using "you" / "your"`;

const SYSTEM_PROMPT_CHAT = `You are a health and wellness coach for a regenerative medicine clinic called Metamorphosis Wellness.

You have access to the patient's health data from the past 28 days (provided below). Use it to give personalized, data-informed answers.

Guidelines:
- Be warm, encouraging, and conversational
- Reference their actual numbers and trends when relevant
- Never diagnose conditions or prescribe medications
- For medical concerns, always suggest they discuss with their Metamorphosis care team
- Focus on actionable lifestyle advice: sleep hygiene, movement, recovery, stress, nutrition
- Keep responses to 2-3 short paragraphs — helpful but not overwhelming
- Use plain language, not medical jargon
- If asked about something outside health/wellness, politely redirect`;

// ── Bundle → Context ───────────────────────────────────────────

/**
 * Condense a resolved bundle into a compact context string for Claude.
 * We include trends, latest snapshot, readiness, confidence, and flags.
 */
function bundleToContext(bundle) {
  if (!bundle) return "No health data available for this patient.";

  const parts = [];

  // Trends summary
  if (bundle.daily_snapshot_trends) {
    parts.push("## 28-Day Trends");
    for (const [metric, trend] of Object.entries(bundle.daily_snapshot_trends)) {
      if (trend.coverage_ratio < 0.1) continue; // skip metrics with almost no data
      const label = metric.replace(/_/g, " ");
      const dir = trend.direction || "unknown";
      const baseline = trend.baseline_value != null ? Number(trend.baseline_value).toFixed(1) : "n/a";
      const latest = trend.latest_value != null ? Number(trend.latest_value).toFixed(1) : "n/a";
      const coverage = Math.round((trend.coverage_ratio || 0) * 100);
      parts.push(`- ${label}: ${baseline} → ${latest} (${dir}, ${coverage}% data coverage)`);
    }
  }

  // Latest day snapshot
  if (bundle.daily_snapshots?.length > 0) {
    const latest = bundle.daily_snapshots[bundle.daily_snapshots.length - 1];
    parts.push("\n## Most Recent Day");
    parts.push(`Date: ${latest.day_key || "unknown"}`);
    if (latest.steps != null) parts.push(`Steps: ${latest.steps}`);
    if (latest.resting_hr != null) parts.push(`Resting HR: ${latest.resting_hr} bpm`);
    if (latest.hrv != null) parts.push(`HRV: ${Number(latest.hrv).toFixed(0)} ms`);
    if (latest.sleep_duration != null) {
      const hrs = Number(latest.sleep_duration);
      parts.push(`Sleep: ${hrs.toFixed(1)} hours`);
    }
    if (latest.respiratory_rate != null) parts.push(`Respiratory Rate: ${Number(latest.respiratory_rate).toFixed(1)} breaths/min`);
  }

  // Readiness
  if (bundle.derived_metrics?.readiness) {
    const r = bundle.derived_metrics.readiness;
    parts.push(`\n## Readiness Score: ${r.score != null ? Math.round(r.score) : "n/a"}/100 (${r.state || "unknown"})`);
  }

  // Confidence
  if (bundle.confidence?.overall) {
    const c = bundle.confidence.overall;
    parts.push(`\n## Data Confidence: ${c.grade} (${Math.round((c.score || 0) * 100)}%)`);
    if (c.reasons?.length) parts.push(`Reasons: ${c.reasons.join("; ")}`);
  }

  // Flags
  if (bundle.flags?.length > 0) {
    parts.push("\n## Flags");
    for (const f of bundle.flags) {
      parts.push(`- [${f.severity}] ${f.message}`);
    }
  }

  // Clinic anchors (brief)
  if (bundle.latest_anchors) {
    const anchors = [];
    if (bundle.latest_anchors.conneqt) {
      const c = bundle.latest_anchors.conneqt;
      anchors.push(`BP: ${c.brachial_systolic}/${c.brachial_diastolic}, Arterial Age: ${c.arterial_age}`);
    }
    if (bundle.latest_anchors.tanita) {
      const t = bundle.latest_anchors.tanita;
      anchors.push(`Body Fat: ${t.body_fat_pct}%, Metabolic Age: ${t.metabolic_age}`);
    }
    if (anchors.length) {
      parts.push("\n## Clinic Assessments");
      anchors.forEach((a) => parts.push(`- ${a}`));
    }
  }

  return parts.join("\n");
}

// ── One-Shot Summary ───────────────────────────────────────────

/**
 * Generate a daily health summary (non-streaming).
 * @param {Object} bundle - Resolved bundle from buildResolvedBundle
 * @returns {Promise<string>} Summary text
 */
async function generateDailySummary(bundle) {
  const apiKey = getApiKey();
  const context = bundleToContext(bundle);

  const body = {
    model: MODEL,
    max_tokens: 300,
    system: SYSTEM_PROMPT_SUMMARY,
    messages: [
      {
        role: "user",
        content: `Here is the patient's health data:\n\n${context}\n\nPlease provide a brief daily health summary.`,
      },
    ],
  };

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error [${response.status}]: ${errText}`);
  }

  const data = await response.json();
  const text =
    data.content?.[0]?.text || "Unable to generate summary at this time.";
  return text;
}

// ── Streaming Chat ─────────────────────────────────────────────

/**
 * Stream a chat response from Claude.
 * @param {Object} bundle - Resolved bundle
 * @param {Array} messages - Conversation history [{role, content}]
 * @param {Function} onChunk - Called with each text chunk as it arrives
 * @returns {Promise<string>} Full accumulated response text
 */
async function streamChatResponse(bundle, messages, onChunk) {
  const apiKey = getApiKey();
  const context = bundleToContext(bundle);

  // Prepend the health context to the first user message or add as a system message
  const systemPrompt = `${SYSTEM_PROMPT_CHAT}\n\n--- Patient Health Data ---\n${context}\n--- End Health Data ---`;

  const body = {
    model: MODEL,
    max_tokens: 1024,
    stream: true,
    system: systemPrompt,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  };

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error [${response.status}]: ${errText}`);
  }

  // Parse SSE stream from Anthropic
  let fullText = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (jsonStr === "[DONE]") continue;

      try {
        const event = JSON.parse(jsonStr);
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta"
        ) {
          const chunk = event.delta.text;
          fullText += chunk;
          if (onChunk) onChunk(chunk);
        }
      } catch {
        // skip malformed JSON lines
      }
    }
  }

  return fullText;
}

module.exports = {
  generateDailySummary,
  streamChatResponse,
  bundleToContext,
  MODEL,
};
