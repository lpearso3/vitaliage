/**
 * Streak Calculator
 * Updates user streaks when a check-in or snapshot is submitted.
 * Automatically awards achievements when thresholds are met.
 */

/**
 * Update a specific streak for a user.
 * If the activity is on the next consecutive day, increment.
 * If same day, no change. If gap, reset to 1.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {string} streakType - 'check_in', 'steps', 'sleep', 'hydration'
 * @param {string} dayKey - YYYY-MM-DD
 * @returns {Object} Updated streak record
 */
async function updateStreak(supabase, userId, streakType, dayKey) {
  // Fetch existing streak
  const { data: existing } = await supabase
    .from('streaks')
    .select('*')
    .eq('user_id', userId)
    .eq('streak_type', streakType)
    .single();

  const today = new Date(dayKey + 'T00:00:00Z');
  let currentCount = 1;
  let longestCount = 1;

  if (existing) {
    const lastDate = new Date(existing.last_activity_date + 'T00:00:00Z');
    const diffDays = Math.round((today - lastDate) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      // Same day — no change
      return existing;
    } else if (diffDays === 1) {
      // Consecutive day — increment
      currentCount = existing.current_count + 1;
      longestCount = Math.max(existing.longest_count, currentCount);
    } else {
      // Gap — reset streak
      currentCount = 1;
      longestCount = existing.longest_count;
    }
  }

  const { data, error } = await supabase
    .from('streaks')
    .upsert({
      user_id: userId,
      streak_type: streakType,
      current_count: currentCount,
      longest_count: longestCount,
      last_activity_date: dayKey,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,streak_type' })
    .select()
    .single();

  if (error) {
    console.error(`[streaks] Error updating ${streakType} streak:`, error.message);
    return null;
  }

  // Check and award achievements
  await checkStreakAchievements(supabase, userId, streakType, currentCount);

  return data;
}

/**
 * Check if streak count has crossed any achievement thresholds.
 */
async function checkStreakAchievements(supabase, userId, streakType, currentCount) {
  // Find matching achievements
  const { data: achievements } = await supabase
    .from('achievements')
    .select('*')
    .eq('category', 'streak')
    .eq('threshold_type', 'consecutive_days')
    .lte('threshold_value', currentCount);

  if (!achievements || achievements.length === 0) return;

  // Filter to ones matching streak type
  const matching = achievements.filter(a => a.key.includes(streakType));

  for (const achievement of matching) {
    // Award if not already earned
    const { error } = await supabase
      .from('user_achievements')
      .upsert({
        user_id: userId,
        achievement_id: achievement.id,
        earned_at: new Date().toISOString()
      }, { onConflict: 'user_id,achievement_id' });

    if (!error) {
      console.log(`[streaks] Awarded achievement "${achievement.title}" to user ${userId}`);
    }
  }
}

/**
 * Check milestone achievements (total count based).
 */
async function checkMilestoneAchievements(supabase, userId, totalCheckIns) {
  const { data: achievements } = await supabase
    .from('achievements')
    .select('*')
    .eq('category', 'milestone')
    .eq('threshold_type', 'total_count')
    .lte('threshold_value', totalCheckIns);

  if (!achievements || achievements.length === 0) return;

  for (const achievement of achievements) {
    await supabase
      .from('user_achievements')
      .upsert({
        user_id: userId,
        achievement_id: achievement.id,
        earned_at: new Date().toISOString()
      }, { onConflict: 'user_id,achievement_id' });
  }
}

/**
 * Get all streaks for a user.
 */
async function getUserStreaks(supabase, userId) {
  const { data, error } = await supabase
    .from('streaks')
    .select('*')
    .eq('user_id', userId)
    .order('streak_type');

  if (error) {
    console.error('[streaks] Error fetching streaks:', error.message);
    return [];
  }
  return data || [];
}

module.exports = {
  updateStreak,
  checkStreakAchievements,
  checkMilestoneAchievements,
  getUserStreaks
};
