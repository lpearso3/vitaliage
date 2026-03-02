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

// ── Metric Explanation ──────────────────────────────────────────

const SYSTEM_PROMPT_METRIC = `You are a health and wellness coach for Metamorphosis Wellness, a regenerative medicine clinic.

You are providing a personalized explanation of a specific health metric for a patient. You have access to their 28-day health data.

Structure your response in exactly these three sections using the headers shown:

**Current Status**
Explain where they are right now with this metric — their latest value, how it compares to healthy ranges, and any notable patterns.

**Your Trend**
Describe how this metric has changed over the past 28 days — improving, declining, or stable. Reference their actual numbers.

**Your Goal**
Suggest a personalized, achievable goal for this metric and give 2-3 specific, actionable tips to help them reach it.

Guidelines:
- Be warm, encouraging, and specific to their actual numbers
- Never diagnose conditions or prescribe medications
- For concerning values, suggest discussing with their care team
- Use plain language, not medical jargon
- Keep total response under 250 words
- Address the patient directly using "you" / "your"`;

/**
 * Generate an AI explanation of a specific health metric.
 * @param {Object} bundle - Resolved bundle
 * @param {string} metric - Metric name (steps, sleep, heart_rate, hrv, readiness)
 * @returns {Promise<string>} Explanation text
 */
async function generateMetricExplanation(bundle, metric) {
  const apiKey = getApiKey();
  const context = bundleToContext(bundle);

  const metricLabels = {
    steps: "Daily Steps",
    sleep: "Sleep Duration & Quality",
    heart_rate: "Resting Heart Rate",
    hrv: "Heart Rate Variability (HRV)",
    readiness: "Readiness Score",
  };

  const label = metricLabels[metric] || metric;

  const body = {
    model: MODEL,
    max_tokens: 500,
    system: SYSTEM_PROMPT_METRIC,
    messages: [
      {
        role: "user",
        content: `Here is my health data:\n\n${context}\n\nPlease explain my **${label}** metric — where I am now, how I'm trending, and what goal I should aim for.`,
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
  return data.content?.[0]?.text || "Unable to generate explanation at this time.";
}

// ── Feedback Loop (Readiness vs Activity Load) ──────────────

const SYSTEM_PROMPT_FEEDBACK_LOOP = `You are a performance analytics coach for Metamorphosis Wellness, a regenerative medicine clinic.

You are analyzing the relationship between a patient's daily readiness (recovery capacity) and their activity load (daily demand) over the past 28 days.

Structure your response in exactly these sections:

**Your Pattern**
Describe the overall pattern you see: Are they consistently pushing on high-readiness days? Resting on low days? Or is there a mismatch?

**Recovery Response**
How does their readiness respond to high-activity days? Do they bounce back quickly or does it take several days? Reference specific patterns in their data.

**Sweet Spot**
Based on their data, what activity load level seems to produce the best next-day readiness? This is their personal "sweet spot" for sustainable training.

**This Week's Strategy**
Based on their current readiness trajectory, give specific guidance for the next few days.

Guidelines:
- Reference actual scores and patterns from their data
- Be specific: "On days your activity load was above 70, your next-day readiness averaged 58"
- Focus on the relationship between the two scores
- Keep total response under 250 words`;

/**
 * Generate feedback loop insights analyzing readiness vs activity load relationship.
 * @param {Object} bundle - Resolved bundle from buildResolvedBundle
 * @returns {Promise<string>} Feedback loop analysis text
 */
async function generateFeedbackLoopInsights(bundle) {
  const apiKey = getApiKey();

  if (!bundle) {
    return "Not enough data yet to analyze your readiness and activity patterns. Keep tracking and we'll identify your personal recovery sweet spot soon!";
  }

  // Extract readiness and activity_load scores from derived metrics
  const readiness = bundle.derived_metrics?.readiness;
  const activityLoad = bundle.derived_metrics?.activity_load;

  // Build context with daily snapshots showing readiness and activity load
  const parts = [];

  parts.push("## 28-Day Readiness vs Activity Load Data");

  if (bundle.daily_snapshots && bundle.daily_snapshots.length > 0) {
    parts.push("Daily Scores (most recent 14 days):");
    const recent = bundle.daily_snapshots.slice(-14);
    for (const snap of recent) {
      const readinessScore = snap.readiness_score != null ? Math.round(snap.readiness_score) : "—";
      const activityLoadScore = snap.activity_load != null ? Math.round(snap.activity_load) : "—";
      parts.push(`- ${snap.day_key}: Readiness ${readinessScore}, Activity Load ${activityLoadScore}`);
    }
  }

  if (readiness) {
    parts.push(`\nCurrent Readiness: ${Math.round(readiness.score ?? 0)}/100 (${readiness.state || "unknown"})`);
  }

  if (activityLoad) {
    parts.push(`Current Activity Load: ${Math.round(activityLoad.score ?? 0)}/100`);
  }

  // Calculate correlations if possible
  if (bundle.daily_snapshots && bundle.daily_snapshots.length > 5) {
    const validPairs = bundle.daily_snapshots
      .filter(s => s.readiness_score != null && s.activity_load != null)
      .slice(-14);

    if (validPairs.length > 3) {
      parts.push(`\nData Quality: ${validPairs.length} days with both readiness and activity load scores`);

      // Simple analysis: high activity days and next-day readiness
      const highActivityDays = validPairs.filter(s => s.activity_load > 70);
      if (highActivityDays.length > 0) {
        const avgReadinessAfterHigh = highActivityDays.reduce((sum, _, i, arr) => {
          const nextIdx = bundle.daily_snapshots.indexOf(arr[i]) + 1;
          if (nextIdx < bundle.daily_snapshots.length) {
            const next = bundle.daily_snapshots[nextIdx];
            if (next.readiness_score != null) return sum + next.readiness_score;
          }
          return sum;
        }, 0) / highActivityDays.length;

        parts.push(`- After high-activity days (>70): Next-day readiness averaged ${Math.round(avgReadinessAfterHigh)}`);
      }
    }
  }

  const context = parts.join("\n");

  const body = {
    model: MODEL,
    max_tokens: 500,
    system: SYSTEM_PROMPT_FEEDBACK_LOOP,
    messages: [
      {
        role: "user",
        content: `Here is my readiness and activity load data:\n\n${context}\n\nPlease analyze the relationship between my readiness (recovery capacity) and activity load (daily demand) and give me specific insights.`,
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
  return data.content?.[0]?.text || "Unable to generate feedback loop analysis at this time.";
}

// ── Readiness Plan ─────────────────────────────────────────────

const SYSTEM_PROMPT_READINESS = `You are a health and wellness coach for Metamorphosis Wellness, a regenerative medicine clinic.

You are creating a personalized daily plan based on a patient's readiness score and health data.

Structure your response in exactly these sections using the headers shown:

**Today's Exercise**
Based on their readiness, suggest specific exercise type, intensity, and duration. Be concrete (e.g. "30-minute brisk walk" not "light exercise").

**Recovery & Rest**
Suggest specific recovery activities for today (stretching, foam rolling, breathing exercises, etc.). Tailor intensity to their readiness.

**Sleep Tonight**
Give 2-3 specific tips to optimize tonight's sleep based on their recent sleep patterns.

**Nutrition Focus**
Suggest 1-2 nutrition priorities for today based on their activity level and recovery needs.

Guidelines:
- Be warm, encouraging, and specific — no generic advice
- Tailor everything to their readiness score and the reasons provided
- For "ready" scores: suggest challenging but smart training
- For "easy" scores: suggest steady, moderate activity
- For "rest" scores: prioritize recovery with gentle movement only
- Never diagnose or prescribe — suggest they talk to their care team for medical concerns
- Keep total response under 300 words
- Use "you" / "your" — speak directly to the patient`;

/**
 * Generate a personalized daily plan based on readiness.
 * @param {Object} bundle - Resolved bundle
 * @param {number} score - Readiness score 0-100
 * @param {string} band - Readiness band (ready/easy/rest)
 * @param {string[]} reasons - Readiness reasons
 * @returns {Promise<string>} Plan text
 */
async function generateReadinessPlan(bundle, score, band, reasons) {
  const apiKey = getApiKey();
  const context = bundleToContext(bundle);

  const reasonsText = reasons && reasons.length > 0
    ? `\nReadiness factors:\n${reasons.map(r => `- ${r}`).join("\n")}`
    : "";

  const body = {
    model: MODEL,
    max_tokens: 600,
    system: SYSTEM_PROMPT_READINESS,
    messages: [
      {
        role: "user",
        content: `Here is my health data:\n\n${context}\n\nMy readiness score is ${score ?? "unknown"}/100 (state: ${band || "unknown"}).${reasonsText}\n\nPlease create my personalized plan for today.`,
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
  return data.content?.[0]?.text || "Unable to generate plan at this time.";
}

// ── Nutrition Insights ─────────────────────────────────────

const SYSTEM_PROMPT_NUTRITION = `You are a nutrition-aware wellness coach for Metamorphosis Wellness, a regenerative medicine clinic.

You are analyzing a patient's nutrition data alongside their glucose trends, wearable metrics, and activity levels to find meaningful patterns and provide actionable advice.

Structure your response in exactly these sections:

**Nutrition Summary**
Brief overview of their recent eating patterns — average calories, macro balance, consistency.

**Glucose Connections**
If glucose data is available, describe any patterns you see between their nutrition and glucose response. What foods or meal timing patterns correlate with glucose spikes or stability?

**Recovery Impact**
How their nutrition may be affecting their sleep, HRV, and readiness scores. Are they fueling recovery adequately?

**Recommendations**
2-3 specific, actionable nutrition suggestions personalized to their data and goals.

Guidelines:
- Reference actual numbers from their data
- Never prescribe specific diets or supplements — suggest discussing with their care team
- Keep total response under 300 words
- Be encouraging and practical`;

/**
 * Generate nutrition insights based on nutrition data and bundle context.
 * @param {Object} bundle - Resolved bundle from buildResolvedBundle
 * @param {Object} nutritionData - { avgCalories, avgProtein, avgCarbs, avgFat, days, hasGlucose }
 * @returns {Promise<string>} Nutrition insights text
 */
async function generateNutritionInsights(bundle, nutritionData) {
  const apiKey = getApiKey();
  const context = bundleToContext(bundle);

  // Build nutrition data context
  const nutritionContext = `
## Recent Nutrition Data (${nutritionData.days} days)
- Average Daily Calories: ${Math.round(nutritionData.avgCalories)} kcal
- Average Daily Protein: ${Math.round(nutritionData.avgProtein)}g
- Average Daily Carbs: ${Math.round(nutritionData.avgCarbs)}g
- Average Daily Fat: ${Math.round(nutritionData.avgFat)}g
- Macro Split: Protein ${Math.round((nutritionData.avgProtein * 4 / (nutritionData.avgCalories || 1)) * 100)}% | Carbs ${Math.round((nutritionData.avgCarbs * 4 / (nutritionData.avgCalories || 1)) * 100)}% | Fat ${Math.round((nutritionData.avgFat * 9 / (nutritionData.avgCalories || 1)) * 100)}%
`;

  const systemPrompt = `${SYSTEM_PROMPT_NUTRITION}\n\n--- Health Context ---\n${context}\n\n${nutritionContext}--- End Context ---`;

  const body = {
    model: MODEL,
    max_tokens: 600,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Analyze my recent nutrition data in the context of my overall health metrics and provide personalized insights.`,
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
  return data.content?.[0]?.text || "Unable to generate nutrition insights at this time.";
}

// ── Supplement Interaction Checker ──────────────────────────

const SYSTEM_PROMPT_SUPPLEMENTS = `You are a pharmacology-aware wellness advisor for a regenerative medicine clinic called Metamorphosis Wellness.

Review the following supplement list and identify any potential interactions between them, or with common medications.

For each interaction you find:
- Specify severity: 'info' (minor/interesting note), 'caution' (moderate consideration), or 'warning' (significant concern)
- List which supplements are involved
- Provide a brief summary (1 sentence)
- Give a detailed explanation with context and recommendations

If asked about prescription drug interactions, always recommend confirming with their pharmacist or care team.

Return a JSON array with objects like:
{
  "severity": "caution",
  "supplements_involved": ["Supplement Name 1", "Supplement Name 2"],
  "summary": "Brief interaction summary",
  "details": "Detailed explanation with recommendations"
}

If no interactions are found, return an empty array: []`;

/**
 * Check supplement interactions using AI analysis.
 * @param {Array<Object>} supplements - Array of {name, dosage, frequency} objects
 * @returns {Promise<Array>} Array of interaction objects
 */
async function checkSupplementInteractions(supplements) {
  if (!supplements || supplements.length === 0) {
    return [];
  }

  const apiKey = getApiKey();

  // Format supplement list for Claude
  const supplementList = supplements
    .map(s => `- ${s.name}${s.dosage ? ` (${s.dosage})` : ''}${s.frequency ? ` - ${s.frequency}` : ''}`)
    .join('\n');

  const body = {
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM_PROMPT_SUPPLEMENTS,
    messages: [
      {
        role: "user",
        content: `Please analyze these supplements for interactions:\n\n${supplementList}`,
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
  const text = data.content?.[0]?.text || "[]";

  try {
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    const interactions = JSON.parse(jsonStr);
    return Array.isArray(interactions) ? interactions : [];
  } catch (err) {
    console.error("Error parsing supplement interaction response:", err, "Response text:", text);
    return [];
  }
}

module.exports = {
  generateDailySummary,
  streamChatResponse,
  generateMetricExplanation,
  generateReadinessPlan,
  generateFeedbackLoopInsights,
  generateNutritionInsights,
  checkSupplementInteractions,
  bundleToContext,
  MODEL,
};
