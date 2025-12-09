(function () {
  const MW = window.mwCore || {};

  // -----------------------------
  // Keys & small helpers
  // -----------------------------
  const SETTINGS_KEY = 'mw_settings';
  const DEV_KEY = 'mw_dev_cfg';

  function clamp(x, min, max) {
    if (x == null || isNaN(x)) return min;
    return Math.min(max, Math.max(min, x));
  }

  function avg(values) {
    const items = (values || []).filter(v => typeof v === 'number' && !isNaN(v));
    if (!items.length) return null;
    const sum = items.reduce((a, b) => a + b, 0);
    return sum / items.length;
  }

  function toDate(d) {
    try { return new Date(d); } catch { return null; }
  }

  function sortByDateAsc(snaps) {
    return [...(snaps || [])].sort((a, b) => {
      const da = toDate(a.date)?.getTime() || 0;
      const db = toDate(b.date)?.getTime() || 0;
      return da - db;
    });
  }

  // -----------------------------
  // Settings helpers
  // -----------------------------
  function getSettingsSafe() {
    try {
      // If Settings tab has already attached window.getSettings(), prefer that
      if (typeof window.getSettings === "function") {
        const s = window.getSettings();
        return s && typeof s === "object" ? s : {};
      }
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  MW.getSettingsSafe = MW.getSettingsSafe || getSettingsSafe;

  MW.getSettings = MW.getSettings || function () {
    const s = getSettingsSafe();
    return s || {};
  };

  // Units (glucose)
  function glucoseUnit() {
    const s = getSettingsSafe();
    const units = (s && s.units) || {};
    const raw = (units.glucose || "").toLowerCase();
    if (raw === "mmol" || raw === "mmol/l" || raw === "mmol/litre") {
      return "mmol/L";
    }
    return "mg/dL";
  }

  MW.glucoseUnit = MW.glucoseUnit || glucoseUnit;

  // Settings change subscription (for Settings tab to notify others)
  const _settingsSubscribers = MW._settingsSubscribers || new Set();

  function onSettingsChange(cb) {
    if (typeof cb !== "function") return () => {};
    _settingsSubscribers.add(cb);
    return function unsubscribe() {
      _settingsSubscribers.delete(cb);
    };
  }

  function _emitSettingsChanged() {
    const current = getSettingsSafe();
    _settingsSubscribers.forEach(fn => {
      try { fn(current); } catch (e) { console.warn("onSettingsChange callback error", e); }
    });
  }

  MW.onSettingsChange = MW.onSettingsChange || onSettingsChange;
  MW._emitSettingsChanged = MW._emitSettingsChanged || _emitSettingsChanged;
  MW._settingsSubscribers = _settingsSubscribers;

  // -----------------------------
  // Profile + VO2 helpers
  // -----------------------------
  function getProfile() {
    const s = getSettingsSafe();
    const p = (s && s.profile) || {};

    let age = null;
    let sex = null;
    let trainingLevel = null; // sedentary | recreational | trained

    if (typeof p.age === "number" && p.age > 0 && p.age < 120) {
      age = p.age;
    }

    if (typeof p.sex === "string") {
      const sx = p.sex.toLowerCase();
      if (sx === "male" || sx === "m") sex = "male";
      if (sx === "female" || sx === "f") sex = "female";
    }

    if (typeof p.trainingLevel === "string") {
      const tl = p.trainingLevel.toLowerCase();
      if (tl.includes("low") || tl.includes("sedentary")) trainingLevel = "sedentary";
      else if (tl.includes("mod") || tl.includes("rec")) trainingLevel = "recreational";
      else if (tl.includes("high") || tl.includes("train")) trainingLevel = "trained";
    }

    // Legacy fallbacks
    if (!age) {
      const legacyAge = parseInt(localStorage.getItem("mw_profile_age"), 10);
      if (legacyAge > 0 && legacyAge < 120) age = legacyAge;
    }

    if (!sex) {
      const legacySex = (localStorage.getItem("mw_profile_sex") || "").toLowerCase();
      if (legacySex === "male" || legacySex === "m") sex = "male";
      if (legacySex === "female" || legacySex === "f") sex = "female";
    }

    if (!trainingLevel) {
      const legacyTL = (localStorage.getItem("mw_profile_training") || "").toLowerCase();
      if (legacyTL.includes("low") || legacyTL.includes("sed")) trainingLevel = "sedentary";
      else if (legacyTL.includes("mod") || legacyTL.includes("rec")) trainingLevel = "recreational";
      else if (legacyTL.includes("high") || legacyTL.includes("train")) trainingLevel = "trained";
    }

    // Sensible defaults to avoid "null profile" everywhere
    return {
      age: age || 45,
      sex: sex || "female",
      trainingLevel: trainingLevel || "recreational",
    };
  }

  MW.getProfile = MW.getProfile || getProfile;

  function resolveProfileForVo2() {
    // For now VO2 uses the same profile fields directly
    return getProfile();
  }

  MW.resolveProfileForVo2 = MW.resolveProfileForVo2 || resolveProfileForVo2;

  function getVo2Ref(age, sex) {
    const a = age || 45;
    const s = sex === "male" ? "male" : "female";

    const bands = [
      { maxAge: 29, male: 46, female: 40 },
      { maxAge: 39, male: 44, female: 38 },
      { maxAge: 49, male: 42, female: 36 },
      { maxAge: 59, male: 39, female: 34 },
      { maxAge: 69, male: 36, female: 32 },
      { maxAge: 200, male: 32, female: 28 }
    ];

    for (let i = 0; i < bands.length; i++) {
      if (a <= bands[i].maxAge) return bands[i][s];
    }
    return s === "male" ? 35 : 30;
  }

  MW.getVo2Ref = MW.getVo2Ref || getVo2Ref;

  function vo2RangeForProfile(profile) {
    const p = profile || resolveProfileForVo2();
    const age = p.age || 45;
    const sex = p.sex || "female";
    const tl = p.trainingLevel || "recreational";

    const base = getVo2Ref(age, sex);

    let spreadLow = 0.8;
    let spreadHigh = 1.15;

    if (tl === "sedentary") {
      spreadLow = 0.7;
      spreadHigh = 1.0;
    } else if (tl === "trained") {
      spreadLow = 0.9;
      spreadHigh = 1.3;
    }

    const lower = Math.round(base * spreadLow);
    const upper = Math.round(base * spreadHigh);

    return {
      low: Math.max(10, lower),
      high: Math.max(lower + 1, upper),
    };
  }

  MW.vo2RangeForProfile = MW.vo2RangeForProfile || vo2RangeForProfile;

  function classifyVo2(vo2, profile) {
    if (vo2 == null || isNaN(vo2)) {
      return {
        band: "unknown",
        comment: "We do not have enough VO₂ max data yet.",
        ref: null,
        diff: null,
      };
    }

    const p = profile || resolveProfileForVo2();
    const ref = getVo2Ref(p.age, p.sex);
    const diff = Math.round((vo2 - ref) * 10) / 10;

    let band;
    if (vo2 < ref * 0.7) band = "low";
    else if (vo2 < ref * 0.9) band = "below-average";
    else if (vo2 <= ref * 1.1) band = "average";
    else if (vo2 <= ref * 1.3) band = "above-average";
    else band = "high";

    let comment;
    if (band === "low") {
      comment = "Below expected for your age and sex—building aerobic fitness will help.";
    } else if (band === "below-average") {
      comment = "Slightly below expected—regular moderate cardio can improve this.";
    } else if (band === "average") {
      comment = "Right around expected—keep up your routine.";
    } else if (band === "above-average") {
      comment = "Above expected—excellent aerobic base.";
    } else {
      comment = "Elite-level aerobic fitness.";
    }

    return { band, comment, ref, diff };
  }

  MW.classifyVo2 = MW.classifyVo2 || classifyVo2;

  // -----------------------------
  // API helpers
  // -----------------------------
  function getApiBaseUrlLocal() {
    try {
      const raw = localStorage.getItem(DEV_KEY);
      if (raw) {
        const cfg = JSON.parse(raw);
        if (cfg && typeof cfg.apiBaseUrl === "string" && cfg.apiBaseUrl.trim().length > 0) {
          return cfg.apiBaseUrl.replace(/\/+$/, "");
        }
      }
    } catch (e) {}
    return "https://vitaliage.onrender.com";
  }

  MW.getApiBaseUrlLocal = MW.getApiBaseUrlLocal || getApiBaseUrlLocal;

  // Stable alias for other tabs / future use
  function getApiBaseUrl() {
    return getApiBaseUrlLocal();
  }

  MW.getApiBaseUrl = MW.getApiBaseUrl || getApiBaseUrl;

  let _snapshotCache = MW._snapshotCache || null;
  let _snapshotCacheTs = MW._snapshotCacheTs || 0;

  async function getSnapshots(limit) {
    const n = typeof limit === "number" && limit > 0 ? limit : 7;

    // Allow an override hook (e.g., native/GoodBarber integration)
    if (typeof window.getSnapshots === "function") {
      try {
        const r = await window.getSnapshots(n);
        if (Array.isArray(r)) return r;
        if (r && Array.isArray(r.snapshots)) return r.snapshots;
      } catch (e) {}
    }

    const now = Date.now();
    if (_snapshotCache && (now - _snapshotCacheTs) < 60000 && _snapshotCache.length >= n) {
      return _snapshotCache.slice(0, n);
    }

    const base = getApiBaseUrlLocal();
    const url = base + "/daily-snapshots?limit=" + encodeURIComponent(n);

    const resp = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!resp.ok) throw new Error("Failed to fetch snapshots");
    const data = await resp.json();
    const list = Array.isArray(data.snapshots) ? data.snapshots : [];

    list.sort((a, b) => new Date(b.date) - new Date(a.date));

    _snapshotCache = list;
    _snapshotCacheTs = Date.now();

    MW._snapshotCache = _snapshotCache;
    MW._snapshotCacheTs = _snapshotCacheTs;

    return list;
  }

  MW.getSnapshots = MW.getSnapshots || getSnapshots;

  // Stable alias name for GoodBarber tabs
  async function fetchDailySnapshots(limit) {
    return getSnapshots(limit);
  }

  MW.fetchDailySnapshots = MW.fetchDailySnapshots || fetchDailySnapshots;

  // -----------------------------
  // Readiness scoring (single snapshot)
  // -----------------------------
  function computeReadinessScore(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    const s = snapshot;

    // Sleep adherence
    let sleepScore = 70;
    if (s.sleep && s.sleep.totalMinutes && s.sleep.goalMinutes) {
      const pct = (s.sleep.totalMinutes / s.sleep.goalMinutes) * 100;
      sleepScore = Math.max(0, Math.min(100, pct));
    }

    // HRV (relative to a generic 60ms)
    let hrvScore = 70;
    if (typeof s.hrv === "number" && s.hrv > 0) {
      const pct = (s.hrv / 60) * 100;
      hrvScore = Math.max(0, Math.min(100, pct));
    }

    // Resting HR (lower is generally better)
    let rhrScore = 70;
    if (typeof s.restingHR === "number") {
      const r = s.restingHR;
      if (r <= 50) rhrScore = 100;
      else if (r <= 60) rhrScore = 95;
      else if (r <= 80) rhrScore = 95 - ((r - 60) * (35 / 20));
      else if (r <= 100) rhrScore = 60 - ((r - 80) * (20 / 20));
      else rhrScore = 35;
      rhrScore = Math.max(0, Math.min(100, rhrScore));
    }

    // Steps vs 8000 target
    let stepScore = 60;
    if (typeof s.steps === "number") {
      const pct = (s.steps / 8000) * 100;
      stepScore = Math.max(0, Math.min(100, pct));
    }

    const readiness = Math.round(
      0.4 * sleepScore +
      0.3 * hrvScore +
      0.2 * rhrScore +
      0.1 * stepScore
    );

    return Math.max(0, Math.min(100, readiness));
  }

  MW.computeReadinessScore = MW.computeReadinessScore || computeReadinessScore;

  // -----------------------------
  // Readiness from a series of snapshots (new canonical helper)
  // -----------------------------
  /**
   * Compute readiness from a series of daily snapshots.
   *
   * @param {Array<Object>} snapshots - most recent first or last (order agnostic, we sort)
   * @param {Object} [profileOverride] - optional { age, sex, trainingLevel } (reserved for future use)
   * @returns {{
   *   score: number,
   *   state: 'ready' | 'easy' | 'rest',
   *   reasons: string[],
   *   components: {
   *     sleepScore: number,
   *     hrvScore: number,
   *     rhrScore: number,
   *     stepsScore: number,
   *     sleep7DayAdherence: number | null,
   *     nightsMeetingGoal: number | null,
   *     hrvDeltaPct: number | null,
   *     rhrDelta: number | null,
   *     stepsAvg: number | null
   *   },
   *   // backward-compat convenience fields:
   *   readinessScore: number,
   *   stepsAvg: number | null
   * }}
   */
  function computeReadinessFromSnapshots(snapshots, profileOverride) {
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      return {
        score: 50,
        state: 'easy',
        reasons: ['Not enough data yet to calculate readiness.'],
        components: {
          sleepScore: 50,
          hrvScore: 50,
          rhrScore: 50,
          stepsScore: 50,
          sleep7DayAdherence: null,
          nightsMeetingGoal: null,
          hrvDeltaPct: null,
          rhrDelta: null,
          stepsAvg: null
        },
        readinessScore: 50,
        stepsAvg: null
      };
    }

    // Sort ascending by date, then keep last 7
    const snaps = sortByDateAsc(snapshots)
      .slice(-7);

    const n = snaps.length;
    const today = snaps[n - 1];

    // ---- Sleep metrics ----
    let sleepMinutesSum = 0;
    let sleepGoalMinutesSum = 0;
    let nightsWithSleep = 0;
    let nightsMeetingGoal = 0;

    snaps.forEach(s => {
      if (s.sleep && typeof s.sleep.totalMinutes === 'number' && typeof s.sleep.goalMinutes === 'number') {
        sleepMinutesSum += s.sleep.totalMinutes;
        sleepGoalMinutesSum += s.sleep.goalMinutes;
        nightsWithSleep++;
        if (s.sleep.metGoal === true || s.sleep.totalMinutes >= s.sleep.goalMinutes) {
          nightsMeetingGoal++;
        }
      }
    });

    const sleep7DayAdherence = (sleepGoalMinutesSum > 0)
      ? (sleepMinutesSum / sleepGoalMinutesSum) // ratio
      : null;

    // Sleep score: 0–100
    let sleepScore = 50;
    if (sleep7DayAdherence != null) {
      const ratio = Math.min(sleep7DayAdherence, 1.2); // cap slight overage
      sleepScore = Math.round(Math.max(0, Math.min(100, ratio * 100)));
      if (sleepScore < 50 && nightsMeetingGoal >= 4) {
        // If they hit goal most nights but minutes ratio is off a bit, soften penalty
        sleepScore = Math.max(sleepScore, 60);
      }
    }

    // ---- HRV metrics ----
    const hrvValues = snaps
      .map(s => (typeof s.hrv === 'number' ? s.hrv : null))
      .filter(v => v != null);

    const hrvToday = (typeof today.hrv === 'number') ? today.hrv : null;
    const hrvAvg = (hrvValues.length > 0)
      ? (hrvValues.reduce((a, b) => a + b, 0) / hrvValues.length)
      : null;

    let hrvDeltaPct = null;
    let hrvScore = 50;

    if (hrvToday != null && hrvAvg && hrvAvg > 0) {
      hrvDeltaPct = ((hrvToday - hrvAvg) / hrvAvg) * 100;
      // +20% or more => 100, -20% => ~0
      const raw = 50 + (hrvDeltaPct / 20) * 50;
      hrvScore = Math.round(Math.max(0, Math.min(100, raw)));
    }

    // ---- Resting HR metrics ----
    const rhrValues = snaps
      .map(s => (typeof s.restingHR === 'number' ? s.restingHR : null))
      .filter(v => v != null);

    const rhrToday = (typeof today.restingHR === 'number') ? today.restingHR : null;
    const rhrAvg = (rhrValues.length > 0)
      ? (rhrValues.reduce((a, b) => a + b, 0) / rhrValues.length)
      : null;

    let rhrDelta = null;
    let rhrScore = 50;

    if (rhrToday != null && rhrAvg != null) {
      rhrDelta = rhrToday - rhrAvg; // + is worse
      // +15 bpm => 0, -10 bpm => 100
      let raw;
      if (rhrDelta >= 15) raw = 0;
      else if (rhrDelta <= -10) raw = 100;
      else {
        // interpolate between +15 -> 0, -10 -> 100
        const range = 25; // from -10 to +15
        const pos = (15 - rhrDelta) / range; // 0–1
        raw = pos * 100;
      }
      rhrScore = Math.round(Math.max(0, Math.min(100, raw)));
    }

    // ---- Steps metrics ----
    const stepValues = snaps
      .map(s => (typeof s.steps === 'number' ? s.steps : null))
      .filter(v => v != null);

    const stepsAvg = (stepValues.length > 0)
      ? (stepValues.reduce((a, b) => a + b, 0) / stepValues.length)
      : null;

    let stepsScore = 50;
    if (stepsAvg != null) {
      // 3k => 40, 7k => 70, 10k => 100, simple clamp
      if (stepsAvg <= 3000) stepsScore = 40;
      else if (stepsAvg >= 10000) stepsScore = 100;
      else {
        const t = (stepsAvg - 3000) / 7000; // 0–1 between 3k and 10k
        stepsScore = Math.round(40 + t * 60);
      }
    }

    // ---- Weights & composite score ----
    const wSleep = 0.4;
    const wHrv = 0.3;
    const wRhr = 0.2;
    const wSteps = 0.1;

    let weights = { sleep: wSleep, hrv: wHrv, rhr: wRhr, steps: wSteps };

    function normalizeWeights(mask) {
      let total = 0;
      Object.keys(weights).forEach(k => {
        if (mask[k]) total += weights[k];
        else weights[k] = 0;
      });
      if (total <= 0) return;
      Object.keys(weights).forEach(k => {
        if (mask[k]) weights[k] = weights[k] / total;
      });
    }

    normalizeWeights({
      sleep: sleep7DayAdherence != null,
      hrv: hrvAvg != null && hrvToday != null,
      rhr: rhrAvg != null && rhrToday != null,
      steps: stepsAvg != null
    });

    const rawScore =
      (sleepScore * weights.sleep) +
      (hrvScore * weights.hrv) +
      (rhrScore * weights.rhr) +
      (stepsScore * weights.steps);

    const finalScore = clamp(Math.round(rawScore), 0, 100);

    let state = 'easy';
    if (finalScore >= 70) state = 'ready';
    else if (finalScore <= 40) state = 'rest';

    // ---- Reasons (short text bullets) ----
    const reasons = [];

    if (sleep7DayAdherence != null) {
      const pct = Math.round(sleep7DayAdherence * 100);
      if (pct >= 95) reasons.push('Sleep has been on target most nights.');
      else if (pct <= 75) reasons.push('Sleep has been below your target recently.');
    }

    if (hrvDeltaPct != null) {
      if (hrvDeltaPct >= 15) reasons.push('HRV is well above your usual baseline.');
      else if (hrvDeltaPct <= -15) reasons.push('HRV is below your usual baseline.');
    }

    if (rhrDelta != null) {
      if (rhrDelta <= -5) reasons.push('Resting heart rate is lower than usual.');
      else if (rhrDelta >= 5) reasons.push('Resting heart rate is higher than usual.');
    }

    if (stepsAvg != null) {
      if (stepsAvg >= 8000) reasons.push('Activity levels have been solid.');
      else if (stepsAvg <= 4000) reasons.push('Activity has been on the lower side.');
    }

    if (reasons.length === 0) {
      reasons.push('Limited data, so this readiness is approximate.');
    }

    return {
      score: finalScore,
      state,
      reasons,
      components: {
        sleepScore,
        hrvScore,
        rhrScore,
        stepsScore,
        sleep7DayAdherence,
        nightsMeetingGoal: nightsWithSleep ? nightsMeetingGoal : null,
        hrvDeltaPct,
        rhrDelta,
        stepsAvg
      },
      // convenience / backward-compat:
      readinessScore: finalScore,
      stepsAvg
    };
  }

  MW.computeReadinessFromSnapshots = MW.computeReadinessFromSnapshots || computeReadinessFromSnapshots;

  // -----------------------------
  // Version + export
  // -----------------------------
  MW.version = MW.version || "1.1.0";

  window.mwCore = MW;

})();
