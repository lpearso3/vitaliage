// services/notifications/morningReadiness.js
const { computeReadinessFromSnapshots } = require("../resolvedBundle/readiness/computeReadinessFromSnapshots");

/**
 * Generate a personalized push notification message based on readiness score
 * @param {number} score - Readiness score (0-100)
 * @param {string|null} workoutType - Type of workout from care plan (e.g., "Running", "Yoga")
 * @returns {{title: string, body: string}}
 */
function generateReadinessMessage(score, workoutType = null) {
  let title = "";
  let body = "";

  if (score >= 80) {
    // Green/Ready - Recommend the workout from care plan
    title = "Ready for Today";
    if (workoutType) {
      body = `Your readiness score is ${score}! Great day for ${workoutType}.`;
    } else {
      body = `Your readiness score is ${score}! You're ready for a great workout today.`;
    }
  } else if (score >= 50) {
    // Yellow/Easy - Recommend lighter activities
    title = "Take It Easy Today";
    body = `Readiness at ${score}. Consider a lighter workout today — maybe a walk or yoga.`;
  } else {
    // Red/Rest - Recommend recovery
    title = "Recovery Day";
    body = `Readiness is low at ${score}. Your body needs recovery today. Focus on sleep and hydration.`;
  }

  return { title, body };
}

/**
 * Extract workout type from care plan goals
 * Looks for workout/exercise goals in the plan
 * @param {object|null} plan - Care plan object
 * @returns {string|null} Workout type (e.g., "Running", "Yoga", "Strength Training")
 */
function extractWorkoutFromPlan(plan) {
  if (!plan || !plan.plan_body) return null;

  const planBody = typeof plan.plan_body === "string"
    ? plan.plan_body
    : JSON.stringify(plan.plan_body);

  // Simple heuristic: look for common workout types in plan content
  const workoutPatterns = [
    { regex: /strength|weight|lifting|resistance/i, type: "Strength Training" },
    { regex: /cardio|running|cycling|hiit|sprinting/i, type: "Cardio" },
    { regex: /yoga|stretching|flexibility|pilates/i, type: "Yoga" },
    { regex: /swimming|water/i, type: "Swimming" },
    { regex: /walking|hiking/i, type: "Walking" },
    { regex: /sports|basketball|tennis|soccer/i, type: "Sports" },
  ];

  for (const pattern of workoutPatterns) {
    if (pattern.regex.test(planBody)) {
      return pattern.type;
    }
  }

  return null;
}

/**
 * Query all active users with device tokens for today's readiness push
 * Compute readiness score and send personalized push notifications
 *
 * @param {object} supabase - Supabase client instance
 * @param {object} apnsProvider - Object with sendPush function (from apns.js)
 * @returns {Promise<{sent: number, failed: number, skipped: number, errors: Array}>}
 */
async function sendMorningReadinessNotifications(supabase, apnsProvider) {
  const results = {
    sent: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  try {
    // Get all active devices with user_id
    const { data: devices, error: devicesErr } = await supabase
      .from("devices")
      .select("id,user_id,token,platform,active")
      .eq("active", true)
      .not("user_id", "is", null); // Only devices with a user

    if (devicesErr) {
      const msg = `Failed to fetch active devices: ${devicesErr.message}`;
      console.error(msg);
      results.errors.push(msg);
      return results;
    }

    if (!devices || devices.length === 0) {
      console.log("No active devices found");
      return results;
    }

    // Group devices by user_id to avoid duplicate sends
    const devicesByUser = new Map();
    for (const device of devices) {
      if (!devicesByUser.has(device.user_id)) {
        devicesByUser.set(device.user_id, []);
      }
      devicesByUser.get(device.user_id).push(device);
    }

    console.log(`Processing ${devicesByUser.size} unique users with ${devices.length} active devices`);

    // Process each user
    for (const [userId, userDevices] of devicesByUser) {
      try {
        // Fetch user's daily snapshots (last 7 days for readiness calculation)
        const { data: snapshots, error: snapsErr } = await supabase
          .from("daily_snapshots")
          .select(
            "day_key,sleep_duration,hrv,resting_hr,steps,snapshot_date"
          )
          .eq("user_id", userId)
          .order("snapshot_date", { ascending: false })
          .limit(7);

        if (snapsErr) {
          results.errors.push(`User ${userId}: Failed to fetch snapshots: ${snapsErr.message}`);
          results.skipped++;
          continue;
        }

        // Compute readiness score
        const readiness = computeReadinessFromSnapshots(snapshots || []);
        const score = readiness.score || 50;

        // Fetch user's active care plan (if any) to extract workout type
        const { data: plans, error: plansErr } = await supabase
          .from("care_plans")
          .select("plan_type,plan_body,title,summary")
          .eq("user_id", userId)
          .eq("status", "active")
          .order("created_at", { ascending: false })
          .limit(1);

        let workoutType = null;
        if (!plansErr && plans && plans.length > 0) {
          workoutType = extractWorkoutFromPlan(plans[0]);
        }

        // Generate personalized message
        const { title, body } = generateReadinessMessage(score, workoutType);

        // Prepare notification payload
        const payload = {
          title,
          body,
          data: {
            readinessScore: String(score),
            state: readiness.state || "easy",
            type: "readiness",
          },
        };

        // Send to all user's devices
        let userSent = 0;
        for (const device of userDevices) {
          try {
            // Only send to iOS devices via APNs
            if (device.platform !== "ios") {
              results.skipped++;
              continue;
            }

            const result = await apnsProvider.sendPush(
              device.token,
              payload,
              { pushType: "alert", priority: 10 }
            );

            if (result.status === 200) {
              results.sent++;
              userSent++;
              console.log(`✓ Sent readiness notification to user ${userId} (device ${device.id}, score ${score})`);
            } else {
              results.failed++;
              const errorMsg = `User ${userId} device ${device.id}: APNs returned ${result.status}`;
              results.errors.push(errorMsg);
              console.error(errorMsg);
            }
          } catch (deviceErr) {
            results.failed++;
            const errorMsg = `User ${userId} device ${device.id}: ${deviceErr.message}`;
            results.errors.push(errorMsg);
            console.error(errorMsg);
          }
        }

        if (userSent === 0 && userDevices.length > 0) {
          results.skipped++;
        }
      } catch (userErr) {
        results.errors.push(`User ${userId}: ${userErr.message}`);
        results.skipped++;
        console.error(`Error processing user ${userId}:`, userErr);
      }
    }
  } catch (err) {
    const msg = `Fatal error in sendMorningReadinessNotifications: ${err.message}`;
    console.error(msg);
    results.errors.push(msg);
  }

  return results;
}

module.exports = { sendMorningReadinessNotifications, generateReadinessMessage, extractWorkoutFromPlan };
