/**
 * Wearable Integration Providers
 * Configuration and data normalization for Garmin, Oura, and WHOOP.
 *
 * Each provider maps its proprietary data format into the
 * daily_snapshots schema used by Vitaliage.
 */

const PROVIDERS = {
  garmin: {
    name: 'Garmin Connect',
    authType: 'oauth1a',      // Garmin uses OAuth 1.0a
    baseUrl: 'https://apis.garmin.com',
    authUrl: 'https://connect.garmin.com/oauthConfirm',
    requestTokenUrl: 'https://connectapi.garmin.com/oauth-service/oauth/request_token',
    accessTokenUrl: 'https://connectapi.garmin.com/oauth-service/oauth/access_token',
    webhookEndpoints: [
      '/dailies',       // Daily summary (steps, calories, distance)
      '/epochs',        // 15-minute activity summaries
      '/sleeps',        // Sleep data
      '/bodyComps',     // Body composition
      '/stressDetails', // Stress data
      '/heartRate'      // Heart rate
    ],
    normalizeDaily: (data) => {
      // Garmin pushes arrays of dailies
      if (!data || !data.dailies) return null;
      const d = Array.isArray(data.dailies) ? data.dailies[0] : data.dailies;
      return {
        steps: d.steps,
        resting_hr: d.restingHeartRateInBeatsPerMinute,
        calories_in: d.activeKilocalories,
        respiratory_rate: d.averageRespirationValue,
        stress_level_avg: d.averageStressLevel,
        vo2_max: d.vo2Max
      };
    },
    normalizeSleep: (data) => {
      if (!data || !data.sleeps) return null;
      const s = Array.isArray(data.sleeps) ? data.sleeps[0] : data.sleeps;
      const durationMs = s.durationInMilliseconds || 0;
      return {
        sleep_total_minutes: Math.round(durationMs / 60000),
        sleep_score: s.overallSleepScore
      };
    }
  },

  oura: {
    name: 'Oura Ring',
    authType: 'oauth2',
    baseUrl: 'https://api.ouraring.com/v2',
    authUrl: 'https://cloud.ouraring.com/oauth/authorize',
    tokenUrl: 'https://api.ouraring.com/oauth/token',
    scopes: 'daily heartrate sleep activity readiness',
    webhookEndpoints: ['/webhook/subscription'],
    normalizeDaily: (data) => {
      // Oura daily_activity
      if (!data) return null;
      return {
        steps: data.steps,
        calories_in: data.active_calories
      };
    },
    normalizeSleep: (data) => {
      if (!data) return null;
      return {
        sleep_total_minutes: data.total_sleep_duration ? Math.round(data.total_sleep_duration / 60) : null,
        hrv: data.average_hrv,
        resting_hr: data.lowest_heart_rate,
        respiratory_rate: data.average_breath
      };
    },
    normalizeReadiness: (data) => {
      if (!data) return null;
      return {
        readiness_score: data.score,
        hrv: data.contributors?.hrv_balance
      };
    }
  },

  whoop: {
    name: 'WHOOP',
    authType: 'oauth2',
    baseUrl: 'https://api.prod.whoop.com/developer/v1',
    authUrl: 'https://api.prod.whoop.com/oauth/oauth2/auth',
    tokenUrl: 'https://api.prod.whoop.com/oauth/oauth2/token',
    scopes: 'read:recovery read:cycles read:sleep read:workout read:body_measurement',
    normalizeRecovery: (data) => {
      if (!data || !data.score) return null;
      return {
        hrv: data.score.hrv_rmssd_milli,
        resting_hr: data.score.resting_heart_rate,
        respiratory_rate: data.score.respiratory_rate,
        recovery_score: data.score.recovery_score
      };
    },
    normalizeSleep: (data) => {
      if (!data || !data.score) return null;
      return {
        sleep_total_minutes: data.score.stage_summary
          ? Math.round(data.score.stage_summary.total_in_bed_time_milli / 60000)
          : null,
        sleep_score: data.score.sleep_performance_percentage
      };
    }
  }
};

/**
 * Get provider configuration.
 * @param {string} provider - 'garmin', 'oura', or 'whoop'
 * @returns {Object|null}
 */
function getProvider(provider) {
  return PROVIDERS[provider] || null;
}

/**
 * Get list of all supported providers.
 */
function listProviders() {
  return Object.entries(PROVIDERS).map(([key, config]) => ({
    key,
    name: config.name,
    authType: config.authType
  }));
}

/**
 * Normalize incoming webhook data from any provider into daily_snapshots fields.
 * @param {string} provider - Provider key
 * @param {string} dataType - 'daily', 'sleep', 'recovery', 'readiness'
 * @param {Object} data - Raw provider data
 * @returns {Object} Normalized fields for daily_snapshots
 */
function normalizeProviderData(provider, dataType, data) {
  const config = PROVIDERS[provider];
  if (!config) return {};

  const normalizerKey = `normalize${dataType.charAt(0).toUpperCase() + dataType.slice(1)}`;
  const normalizer = config[normalizerKey];

  if (!normalizer) return {};

  const result = normalizer(data);

  // Remove null/undefined values
  if (!result) return {};
  return Object.fromEntries(
    Object.entries(result).filter(([, v]) => v != null)
  );
}

module.exports = {
  PROVIDERS,
  getProvider,
  listProviders,
  normalizeProviderData
};
