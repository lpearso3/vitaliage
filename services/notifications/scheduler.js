// services/notifications/scheduler.js
/**
 * Scheduler for morning readiness notifications
 *
 * This can be used in two ways:
 * 1. With node-cron installed: `scheduler.startCronJobs(supabase, apnsProvider)`
 *    - Automatically runs at 7:00 AM daily
 *
 * 2. Without node-cron: Trigger via external tools (Render cron, GitHub Actions, etc.)
 *    - Call `sendMorningReadinessNotifications` directly from the API endpoint
 */

const { sendMorningReadinessNotifications } = require("./morningReadiness");

let cronJob = null;

/**
 * Start daily cron jobs (requires node-cron)
 * Runs morning readiness notification job at 7:00 AM daily
 * @param {object} supabase - Supabase client instance
 * @param {object} apnsProvider - APNs provider with sendPush function
 * @returns {boolean} true if cron started, false if node-cron not available
 */
async function startCronJobs(supabase, apnsProvider) {
  try {
    // Try to require node-cron; if not installed, warn and return false
    let cron;
    try {
      cron = require("node-cron");
    } catch (e) {
      console.warn(
        "⚠️  node-cron not installed. Morning readiness notifications will not run automatically."
      );
      console.warn("   Install with: npm install node-cron");
      console.warn("   Or trigger manually via POST /admin/send-morning-readiness");
      return false;
    }

    // Schedule: Every day at 07:00 (7 AM UTC)
    // Cron format: minute hour dayOfMonth month dayOfWeek
    const cronExpression = "0 7 * * *";

    cronJob = cron.schedule(cronExpression, async () => {
      const now = new Date().toISOString();
      console.log(`[${now}] Running morning readiness notification job...`);

      try {
        const results = await sendMorningReadinessNotifications(
          supabase,
          apnsProvider
        );
        console.log(
          `[${now}] Morning readiness job completed:`,
          JSON.stringify(results)
        );

        // Log errors if any
        if (results.errors && results.errors.length > 0) {
          console.warn("Errors occurred during job:", results.errors);
        }
      } catch (err) {
        console.error(`[${now}] Error in scheduled job:`, err);
      }
    });

    console.log(
      "✓ Morning readiness cron job started (runs daily at 07:00 UTC)"
    );
    return true;
  } catch (err) {
    console.error("Failed to start cron jobs:", err);
    return false;
  }
}

/**
 * Stop the cron job (for graceful shutdown)
 */
function stopCronJobs() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log("✓ Morning readiness cron job stopped");
  }
}

module.exports = {
  startCronJobs,
  stopCronJobs,
  sendMorningReadinessNotifications,
};
