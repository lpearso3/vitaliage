/**
 * Personalized Insights Generator
 * Analyzes resolved bundle trends and check-in data
 * to generate actionable, human-readable insights.
 */

const INSIGHT_RULES = [
  // Sleep insights
  {
    metric: 'sleep_duration',
    check: (trend) => trend.direction === 'down' && Math.abs(trend.delta_pct) > 10,
    type: 'trend',
    priority: 'high',
    title: 'Sleep declining',
    bodyFn: (trend) => `Your sleep has dropped ${Math.abs(Math.round(trend.delta_pct))}% over the past ${trend.window_days || 28} days. Even small sleep deficits compound — try setting a consistent bedtime this week.`,
    direction: 'declining'
  },
  {
    metric: 'sleep_duration',
    check: (trend) => trend.direction === 'up' && trend.delta_pct > 10,
    type: 'trend',
    priority: 'low',
    title: 'Sleep improving',
    bodyFn: (trend) => `Great news — your sleep duration is up ${Math.round(trend.delta_pct)}%. Keep it up! Consistent sleep is one of the strongest predictors of overall health.`,
    direction: 'improving'
  },

  // HRV insights
  {
    metric: 'hrv',
    check: (trend) => trend.direction === 'up' && trend.delta_pct > 8,
    type: 'trend',
    priority: 'low',
    title: 'HRV trending up',
    bodyFn: (trend) => `Your heart rate variability has improved ${Math.round(trend.delta_pct)}%. This suggests your body is recovering well and adapting to stress more effectively.`,
    direction: 'improving'
  },
  {
    metric: 'hrv',
    check: (trend) => trend.direction === 'down' && Math.abs(trend.delta_pct) > 12,
    type: 'trend',
    priority: 'high',
    title: 'HRV dropping',
    bodyFn: (trend) => `Your HRV has decreased ${Math.abs(Math.round(trend.delta_pct))}%. This could signal accumulated stress or under-recovery. Consider prioritizing rest and sleep quality.`,
    direction: 'declining'
  },

  // Resting heart rate insights
  {
    metric: 'resting_hr',
    check: (trend) => trend.direction === 'up' && trend.latest > 75,
    type: 'alert',
    priority: 'medium',
    title: 'Resting heart rate elevated',
    bodyFn: (trend) => `Your resting heart rate is ${Math.round(trend.latest)} bpm, which is higher than ideal. Elevated RHR can indicate stress, dehydration, or inadequate recovery.`,
    direction: 'declining'
  },
  {
    metric: 'resting_hr',
    check: (trend) => trend.direction === 'down' && trend.latest < 65,
    type: 'trend',
    priority: 'low',
    title: 'Heart rate improving',
    bodyFn: (trend) => `Your resting heart rate is a healthy ${Math.round(trend.latest)} bpm and trending down. This is a great sign of cardiovascular fitness.`,
    direction: 'improving'
  },

  // Steps insights
  {
    metric: 'steps',
    check: (trend) => trend.latest >= 10000 && trend.direction === 'up',
    type: 'milestone',
    priority: 'low',
    title: 'Step goal crushed!',
    bodyFn: (trend) => `You're averaging ${Math.round(trend.latest).toLocaleString()} steps — above the 10,000 daily target. Your activity level is excellent!`,
    direction: 'improving'
  },
  {
    metric: 'steps',
    check: (trend) => trend.latest < 5000 && trend.coverage > 0.5,
    type: 'tip',
    priority: 'medium',
    title: 'Let\'s get moving',
    bodyFn: (trend) => `You're averaging ${Math.round(trend.latest).toLocaleString()} steps per day. Try adding a 15-minute walk after lunch — small changes add up quickly.`,
    direction: 'declining'
  },

  // Respiratory rate insights
  {
    metric: 'respiratory_rate',
    check: (trend) => trend.latest > 20,
    type: 'alert',
    priority: 'high',
    title: 'Respiratory rate elevated',
    bodyFn: (trend) => `Your respiratory rate is ${trend.latest.toFixed(1)} breaths/min, which is above the normal range. If this persists, consider discussing it with your care team.`,
    direction: 'declining'
  }
];

/**
 * Generate insights from a resolved bundle's daily_snapshot_trends.
 *
 * @param {Object} trends - daily_snapshot_trends from resolved bundle
 * @param {string} dayKey - Current day key (YYYY-MM-DD)
 * @returns {Array} Array of insight objects ready for DB insertion
 */
function generateInsightsFromTrends(trends, dayKey) {
  if (!trends || typeof trends !== 'object') return [];

  const insights = [];

  for (const rule of INSIGHT_RULES) {
    const trend = trends[rule.metric];
    if (!trend || trend.coverage < 0.3) continue; // Need at least 30% data coverage

    try {
      if (rule.check(trend)) {
        insights.push({
          day_key: dayKey,
          insight_type: rule.type,
          title: rule.title,
          body: rule.bodyFn(trend),
          priority: rule.priority,
          metric_key: rule.metric,
          trend_direction: rule.direction,
          dismissed: false
        });
      }
    } catch (e) {
      // Rule check failed — skip silently
    }
  }

  return insights;
}

/**
 * Generate and store insights for a user.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {Object} bundle - Resolved bundle from buildResolvedBundle
 * @returns {Array} Newly generated insights
 */
async function generateAndStoreInsights(supabase, userId, bundle) {
  if (!bundle || !bundle.daily_snapshot_trends) return [];

  const dayKey = bundle.day_key || new Date().toISOString().slice(0, 10);
  const insights = generateInsightsFromTrends(bundle.daily_snapshot_trends, dayKey);

  if (insights.length === 0) return [];

  // Add user_id to each insight
  const rows = insights.map(i => ({ ...i, user_id: userId }));

  // Check for existing insights for this user/day to avoid duplicates
  const { data: existing } = await supabase
    .from('insights')
    .select('title')
    .eq('user_id', userId)
    .eq('day_key', dayKey);

  const existingTitles = new Set((existing || []).map(e => e.title));
  const newInsights = rows.filter(r => !existingTitles.has(r.title));

  if (newInsights.length === 0) return [];

  const { data, error } = await supabase
    .from('insights')
    .insert(newInsights)
    .select();

  if (error) {
    console.error('[insights] Error storing insights:', error.message);
    return [];
  }

  console.log(`[insights] Generated ${data.length} new insights for user ${userId}`);
  return data;
}

/**
 * Get active (undismissed) insights for a user.
 */
async function getActiveInsights(supabase, userId, limit = 20) {
  const { data, error } = await supabase
    .from('insights')
    .select('*')
    .eq('user_id', userId)
    .eq('dismissed', false)
    .order('priority', { ascending: true }) // high first (alphabetical: alert, high, low, medium)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[insights] Error fetching insights:', error.message);
    return [];
  }
  return data || [];
}

module.exports = {
  generateInsightsFromTrends,
  generateAndStoreInsights,
  getActiveInsights
};
