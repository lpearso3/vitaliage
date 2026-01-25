// services/resolvedBundle/confidence/computeConfidence.js

function clamp01(x) {
  if (x == null || Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function gradeFromScore(score) {
  if (score >= 0.75) return "high";
  if (score >= 0.45) return "med";
  return "low";
}

function daysBetweenDayKeys(a, b) {
  // a, b are "YYYY-MM-DD"
  if (!a || !b) return null;
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.floor((ta - tb) / (24 * 60 * 60 * 1000));
}

/**
 * daily_snapshot_trends shape assumed:
 * {
 *   metric_key: {
 *     baseline_value, latest_value, delta, direction,
 *     volatility, trend_strength, coverage_ratio, data_gaps
 *   },
 *   ...
 * }
 *
 * resolved_metrics shape assumed:
 * {
 *   metric_key: { value, source, measured_at, day_key, quality, protocol_version },
 *   ...
 * }
 *
 * resolved_metrics_provenance shape assumed:
 * {
 *   metric_key: { metric_key, source, rule, day_key, as_of_day_key, measured_at, is_null, ... },
 *   ...
 * }
 *
 * Output shape (LOCKED):
 * confidence: {
 *   overall: { score, grade, reasons },
 *   trends: { [metricKey]: { score, reasons, coverage } },
 *   resolved: { [metricKey]: { score, reasons, provenance } }
 * }
 *
 * Hygiene:
 * - confidence.metrics must never exist.
 */
function computeConfidence({
  bundleDayKey,
  windowDays, // unused for now; reserved
  dailySnapshotTrends,
  resolvedMetrics,
  resolvedMetricsProvenance,
}) {
  const trends = {};
  const resolved = {};

  // Step 2 confidence: coverage-based for trend metrics
  if (dailySnapshotTrends && typeof dailySnapshotTrends === "object") {
    for (const [metricKey, t] of Object.entries(dailySnapshotTrends)) {
      const hasBaseline = t?.baseline_value != null;
      const hasLatest = t?.latest_value != null;

      const coverageRatio = t?.coverage_ratio ?? 0;
      const dataGaps = t?.data_gaps ?? 0;

      const reasons = [];
      const coverage = {
        has_baseline: hasBaseline,
        has_latest: hasLatest,
        coverage_ratio: coverageRatio,
        data_gaps: dataGaps,
        volatility: t?.volatility ?? null,
        trend_strength: t?.trend_strength ?? null,
      };

      const isInsufficient = t?.direction === "insufficient_data";
      if (isInsufficient) reasons.push("insufficient_data");

      let score = 0;

      // If we don't have baseline+latest, it's insufficient points.
      if (!hasBaseline || !hasLatest) {
        score = 0.2;
        reasons.push("insufficient_points");
      } else if (isInsufficient) {
        // Step 2 says insufficient window even though baseline+latest exist.
        score = 0.2;
        reasons.push("insufficient_points");
      } else if (coverageRatio >= 0.8) {
        score = 0.9;
        reasons.push("strong_coverage");
      } else if (coverageRatio >= 0.5) {
        score = 0.6;
        reasons.push("moderate_coverage");
      } else {
        score = 0.3;
        reasons.push("poor_coverage");
      }

      if (dataGaps > 0) reasons.push("data_gaps_present");

      trends[metricKey] = {
        score: clamp01(score),
        reasons,
        coverage,
      };
    }
  }

  // Step 3 confidence: provenance-based for resolved metrics
  if (resolvedMetrics && typeof resolvedMetrics === "object") {
    for (const [metricKey, metricObj] of Object.entries(resolvedMetrics)) {
      const prov = resolvedMetricsProvenance?.[metricKey] ?? null;
      const reasons = [];

      const value = metricObj?.value;

      if (value == null) {
        resolved[metricKey] = {
          score: 0,
          reasons: ["missing_value"],
          provenance:
            prov ?? {
              metric_key: metricKey,
              source: "unknown",
              rule: "unknown",
              day_key: bundleDayKey ?? null,
              as_of_day_key: null,
              measured_at: null,
              is_null: true,
            },
        };
        continue;
      }

      // default mid
      let score = 0.6;

      // deterministic source lift (locked precedence intent)
      const src = prov?.source;
      if (src === "conneqt") {
        score = 0.9;
        reasons.push("clinical_device_source");
      } else if (src === "tanita" || src === "charder") {
        score = 0.85;
        reasons.push("body_comp_anchor_source");
      } else if (src === "wearable") {
        score = 0.6;
        reasons.push("wearable_source");
      } else {
        score = 0.5;
        reasons.push("unknown_source");
      }

      // As-of anchor staleness penalty (deterministic)
      if (prov?.rule === "as-of" && prov?.as_of_day_key) {
        const daysOld = daysBetweenDayKeys(bundleDayKey, prov.as_of_day_key);

        if (typeof daysOld === "number" && daysOld > 0) {
          if (daysOld > 30) {
            score -= 0.25;
            reasons.push("anchor_stale_gt_30d");
          } else if (daysOld > 7) {
            score -= 0.1;
            reasons.push("anchor_stale_gt_7d");
          } else {
            reasons.push("anchor_recent");
          }
        }
      }

      resolved[metricKey] = {
        score: clamp01(score),
        reasons,
        provenance:
          prov ?? {
            metric_key: metricKey,
            source: "unknown",
            rule: "unknown",
            day_key: bundleDayKey ?? null,
            as_of_day_key: null,
            measured_at: null,
            is_null: false,
          },
      };
    }
  }

  // Overall includes both trends + resolved (matches your bundle outputs)
  const allScores = [
    ...Object.values(trends).map((m) => m?.score),
    ...Object.values(resolved).map((m) => m?.score),
  ].filter((s) => typeof s === "number");

  const overallScore = allScores.length
    ? allScores.reduce((a, b) => a + b, 0) / allScores.length
    : 0;

  // Deterministic overall reasons (coverage + provenance summary)
  const overallReasons = [];
  if (!allScores.length) {
    overallReasons.push("no_metrics_scored");
  } else {
    // Trend coverage summary
    const trendCoverages = Object.values(trends)
      .map((m) => m?.coverage?.coverage_ratio)
      .filter((c) => typeof c === "number");

    if (trendCoverages.length) {
      // median coverage ratio
      const sorted = [...trendCoverages].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

      if (median < 0.5) overallReasons.push("low_trend_coverage");
      else overallReasons.push("adequate_trend_coverage");
    } else {
      overallReasons.push("no_trend_metrics");
    }

    // Wearable scarcity: count Step 2 trend metrics with insufficient points/data
    const insufficientCount = Object.values(trends).filter(
      (m) =>
        Array.isArray(m?.reasons) &&
        (m.reasons.includes("insufficient_points") ||
          m.reasons.includes("insufficient_data"))
    ).length;

    if (insufficientCount >= 3) overallReasons.push("limited_wearable_data");

    // Strong clinic anchors present
    const hasClinicAnchors = Object.values(resolved).some((m) => {
      const src2 = m?.provenance?.source;
      return src2 === "conneqt" || src2 === "tanita" || src2 === "charder";
    });

    if (hasClinicAnchors) overallReasons.push("strong_clinic_anchors_present");
  }

  const overall = {
    score: clamp01(overallScore),
    grade: gradeFromScore(clamp01(overallScore)),
    reasons: overallReasons,
  };

  // Hard guard: prevent accidental reintroduction of confidence.metrics
  // (No-op unless someone mutates the object later.)
  if (Object.prototype.hasOwnProperty.call({ overall, trends, resolved }, "metrics")) {
    throw new Error("Invalid confidence shape: confidence.metrics is not allowed");
  }

  return { overall, trends, resolved };
}

module.exports = { computeConfidence };
