// services/resolvedBundle/provenanceSummary.js

function clamp01(x) {
  if (x == null || Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function median(nums) {
  const arr = (nums || [])
    .filter((n) => typeof n === "number")
    .sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function countBy(arr, keyFn) {
  const m = {};
  for (const x of arr || []) {
    const k = keyFn(x);
    if (!k) continue;
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

/**
 * Deterministic summary for downstream UI/logging (excluded from bundle_hash).
 *
 * Hygiene:
 * - Must never reference confidence.metrics.
 * - Only confidence.overall / confidence.trends / confidence.resolved are valid.
 */
function buildProvenanceSummary({
  dailySnapshotTrends,
  resolvedMetricsProvenance,
  confidence,
}) {
  const trendCoverages = Object.values(dailySnapshotTrends || {})
    .map((t) => t?.coverage_ratio)
    .filter((n) => typeof n === "number");

  const coverageMedian = median(trendCoverages);

  const provList = Object.values(resolvedMetricsProvenance || {});
  const sources = countBy(provList, (p) => p?.source || "unknown");
  const rules = countBy(provList, (p) => p?.rule || "unknown");

  // optional: how many resolved metrics are stale >7d / >30d
  const staleGt7 = (provList || []).filter((p) => {
    const key = p?.metric_key;
    const reasons = key ? confidence?.resolved?.[key]?.reasons : null;
    return Array.isArray(reasons) ? reasons.includes("anchor_stale_gt_7d") : false;
  }).length;

  const staleGt30 = (provList || []).filter((p) => {
    const key = p?.metric_key;
    const reasons = key ? confidence?.resolved?.[key]?.reasons : null;
    return Array.isArray(reasons) ? reasons.includes("anchor_stale_gt_30d") : false;
  }).length;

  return {
    trends: {
      median_coverage_ratio:
        coverageMedian == null ? null : clamp01(coverageMedian),
      metrics_with_data: trendCoverages.length,
    },
    resolved: {
      sources,
      rules,
      stale_anchor_gt_7d: staleGt7,
      stale_anchor_gt_30d: staleGt30,
    },
    confidence_overall: confidence?.overall ?? null,
  };
}

module.exports = { buildProvenanceSummary };
