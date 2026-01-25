// services/resolvedBundle/flags/buildFlags.js

function clamp01(x) {
  if (x == null || Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function daysBetweenDayKeys(a, b) {
  if (!a || !b) return null;
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.floor((ta - tb) / (24 * 60 * 60 * 1000));
}

/**
 * Deterministic flags. No ML. No DB writes. Excluded from bundle_hash.
 *
 * Output format:
 * [
 *   { key, severity, message, metric_keys:[], evidence:{} },
 *   ...
 * ]
 *
 * severity: "info" | "warn" | "high"
 *
 * Hygiene:
 * - Must never reference confidence.metrics.
 * - Only confidence.overall / confidence.trends / confidence.resolved are valid.
 *
 * This module also merges duplicate flags by `key` deterministically.
 */
function buildFlags({
  bundleDayKey,
  dailySnapshotTrends,
  resolvedMetricsProvenance,
  confidence,
}) {
  const flags = [];

  const trendObj = dailySnapshotTrends || {};
  const trendKeys = Object.keys(trendObj);

  // 1) Data coverage flags (Step 2)
  const coverages = trendKeys
    .map((k) => trendObj[k]?.coverage_ratio)
    .filter((v) => typeof v === "number");

  if (coverages.length) {
    const sorted = [...coverages].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    const med = clamp01(median);

    if (med < 0.2) {
      flags.push({
        key: "low_wearable_coverage",
        severity: "warn",
        message: "Wearable trend coverage is low in the current window.",
        metric_keys: trendKeys,
        evidence: { median_coverage_ratio: med },
      });
    } else if (med < 0.5) {
      flags.push({
        key: "moderate_wearable_coverage",
        severity: "info",
        message: "Wearable trend coverage is moderate in the current window.",
        metric_keys: trendKeys,
        evidence: { median_coverage_ratio: med },
      });
    }
  } else {
    flags.push({
      key: "no_wearable_trends",
      severity: "warn",
      message: "No wearable trend metrics were available in the current window.",
      metric_keys: [],
      evidence: {},
    });
  }

  // 2) Anchor staleness flags (Step 3 provenance)
  // Add per-metric evidence; later we merge by key.
  const prov = resolvedMetricsProvenance || {};
  for (const [metricKey, p] of Object.entries(prov)) {
    if (p?.rule !== "as-of" || !p?.as_of_day_key) continue;

    const daysOld = daysBetweenDayKeys(bundleDayKey, p.as_of_day_key);
    if (typeof daysOld !== "number") continue;

    if (daysOld > 30) {
      flags.push({
        key: "anchor_stale_gt_30d",
        severity: "high",
        message: "A clinic anchor used for resolution is older than 30 days.",
        metric_keys: [metricKey],
        evidence: {
          metrics: {
            [metricKey]: { as_of_day_key: p.as_of_day_key, days_old: daysOld },
          },
        },
      });
    } else if (daysOld > 7) {
      flags.push({
        key: "anchor_stale_gt_7d",
        severity: "warn",
        message: "A clinic anchor used for resolution is older than 7 days.",
        metric_keys: [metricKey],
        evidence: {
          metrics: {
            [metricKey]: { as_of_day_key: p.as_of_day_key, days_old: daysOld },
          },
        },
      });
    }
  }

  // 3) Confidence-based summary flag
  const overall = confidence?.overall;
  if (overall?.grade === "low") {
    flags.push({
      key: "low_overall_confidence",
      severity: "info",
      message: "Overall confidence is low; interpret trends with caution.",
      metric_keys: [],
      evidence: { score: overall?.score ?? null, reasons: overall?.reasons ?? [] },
    });
  }

  // Optional: if any resolved metric confidence reasons indicate anchor stale, ensure summary flags exist
  // (does not rely on confidence.metrics; only confidence.resolved)
  const resolvedEntries = confidence?.resolved ? Object.entries(confidence.resolved) : [];
  const anyStale7 = resolvedEntries.some(([_, v]) =>
    Array.isArray(v?.reasons) ? v.reasons.includes("anchor_stale_gt_7d") : false
  );
  const anyStale30 = resolvedEntries.some(([_, v]) =>
    Array.isArray(v?.reasons) ? v.reasons.includes("anchor_stale_gt_30d") : false
  );

  if (anyStale30 && !flags.some((f) => f.key === "anchor_stale_gt_30d")) {
    flags.push({
      key: "anchor_stale_gt_30d",
      severity: "high",
      message: "A clinic anchor used for resolution is older than 30 days.",
      metric_keys: [],
      evidence: {},
    });
  }
  if (anyStale7 && !flags.some((f) => f.key === "anchor_stale_gt_7d")) {
    flags.push({
      key: "anchor_stale_gt_7d",
      severity: "warn",
      message: "A clinic anchor used for resolution is older than 7 days.",
      metric_keys: [],
      evidence: {},
    });
  }

  // --- Merge duplicates deterministically by key ---
  const sevRank = { high: 0, warn: 1, info: 2 };

  function mergeFlag(a, b) {
    // severity: keep the highest severity (lowest rank)
    const ra = sevRank[a.severity] ?? 9;
    const rb = sevRank[b.severity] ?? 9;
    const severity = ra <= rb ? a.severity : b.severity;

    // message: keep lexicographically smallest to be deterministic
    const message =
      String(a.message) <= String(b.message) ? a.message : b.message;

    // metric_keys: union + sorted
    const mk = new Set([...(a.metric_keys || []), ...(b.metric_keys || [])]);
    const metric_keys = Array.from(mk).sort((x, y) =>
      String(x).localeCompare(String(y))
    );

    // evidence: shallow merge with special handling for evidence.metrics
    const evidence = { ...(a.evidence || {}), ...(b.evidence || {}) };

    const am = a?.evidence?.metrics || null;
    const bm = b?.evidence?.metrics || null;
    if (am || bm) {
      evidence.metrics = { ...(am || {}), ...(bm || {}) };
    }

    return {
      key: a.key,
      severity,
      message,
      metric_keys,
      evidence,
    };
  }

  const merged = new Map();
  for (const f of flags) {
    const prev = merged.get(f.key);
    merged.set(f.key, prev ? mergeFlag(prev, f) : f);
  }

  const out = Array.from(merged.values());

  // Deterministic ordering: severity then key
  out.sort((a, b) => {
    const sa = sevRank[a.severity] ?? 9;
    const sb = sevRank[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    return String(a.key).localeCompare(String(b.key));
  });

  return out;
}

module.exports = { buildFlags };
