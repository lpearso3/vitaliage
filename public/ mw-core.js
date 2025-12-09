// mw-core.js
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
  // Readiness from a series of snapshots
  // -----------------------------
  function computeReadinessFromSnapshots(snaps) {
    const sorted = sortByDateAsc(snaps || []);
    if (!sorted.length) {
      return {
        readinessScore: 50,
        state: "easy",
        reasons: ["Limited recent data – taking a neutral starting point."],
        hrvToday: null,
        rhrToday: null,
        stepsAvg: null,
        vo2: null,
        vo2Info: null
      };
    }

    const today = sorted[sorted.length - 1];
    const past = sorted.slice(0, -1);

    // Sleep adherence (multi-day)
    const sleepRatios = sorted
      .map(s => {
        const sl = s.sleep || {};
        const t = typeof sl.totalMinutes === "number" ? sl.totalMinutes : null;
        const g = typeof sl.goalMinutes === "number" ? sl.goalMinutes : null;
        if (!t || !g || g <= 0) return null;
        return Math.min(1.2, t / g); // cap
      })
      .filter(v => v != null);

    const sleepAdherenceAvg = sleepRatios.length ? avg(sleepRatios) : null;

    // HRV baseline vs today
    const hrvToday = typeof today.hrv === "number" ? today.hrv : null;
    const hrvBaseline = past.length
      ? avg(past.map(p => (typeof p.hrv === "number" ? p.hrv : null)))
      : null;

    // Resting HR baseline vs today
    const rhrToday = typeof today.restingHR === "number" ? today.restingHR : null;
    const rhrBaseline = past.length
      ? avg(past.map(p => (typeof p.restingHR === "number" ? p.restingHR : null)))
      : null;

    // Steps average
    const stepsAvg = avg(sorted.map(s => (typeof s.steps === "number" ? s.steps : null)));

    // VO2 from latest day
    const vo2 = typeof today.vo2Max === "number" ? today.vo2Max : null;
    const vo2Info = vo2 != null ? classifyVo2(vo2, resolveProfileForVo2()) : null;

    let score = 100;
    const reasons = [];

    // Sleep
    if (sleepAdherenceAvg != null) {
      if (sleepAdherenceAvg >= 1.0) {
        reasons.push("Sleep has been on target or slightly above your goal.");
      } else if (sleepAdherenceAvg >= 0.8) {
        score -= 10;
        reasons.push("Sleep has been slightly below your goal recently.");
      } else if (sleepAdherenceAvg >= 0.6) {
        score -= 20;
        reasons.push("Sleep has been consistently below goal, which can reduce recovery.");
      } else {
        score -= 30;
        reasons.push("Significant sleep debt over the last week.");
      }
    } else {
      reasons.push("Not enough consistent sleep data to calibrate readiness from sleep.");
      score -= 5;
    }

    // HRV
    if (hrvBaseline != null && hrvToday != null && hrvBaseline > 0) {
      const hrvDeltaPct = (hrvToday - hrvBaseline) / hrvBaseline;
      if (hrvDeltaPct >= 0.1) {
        reasons.push("HRV is above your recent baseline – good recovery signal.");
      } else if (hrvDeltaPct >= 0) {
        score -= 5;
        reasons.push("HRV is near baseline – neutral recovery signal.");
      } else if (hrvDeltaPct >= -0.2) {
        score -= 15;
        reasons.push("HRV is slightly below baseline – recovery may be incomplete.");
      } else {
        score -= 25;
        reasons.push("HRV is well below baseline – body may need more recovery.");
      }
    } else {
      reasons.push("HRV data is limited; using other metrics more heavily.");
      score -= 5;
    }

    // Resting HR
    if (rhrBaseline != null && rhrToday != null) {
      const delta = rhrToday - rhrBaseline;
      if (delta <= 1) {
        reasons.push("Resting heart rate is stable vs your recent baseline.");
      } else if (delta <= 5) {
        score -= 10;
        reasons.push("Resting heart rate is mildly elevated vs baseline.");
      } else if (delta <= 10) {
        score -= 20;
        reasons.push("Resting heart rate is noticeably elevated – suggests strain or stress.");
      } else {
        score -= 30;
        reasons.push("Resting heart rate is significantly elevated – strong sign to ease off.");
      }
    } else {
      reasons.push("Limited resting heart rate data, relying more on other signals.");
      score -= 5;
    }

    // Steps / activity
    if (stepsAvg != null) {
      if (stepsAvg >= 8000) {
        reasons.push("Activity volume has been solid over the last week.");
      } else if (stepsAvg >= 5000) {
        score -= 5;
        reasons.push("Activity volume is moderate – fine, but could be improved.");
      } else if (stepsAvg >= 3000) {
        score -= 10;
        reasons.push("Activity has been on the low side recently.");
      } else {
        score -= 15;
        reasons.push("Very low activity volume over the last week.");
      }
    } else {
      reasons.push("No recent step data; cannot factor daily activity into readiness.");
    }

    score = clamp(Math.round(score), 0, 100);

    let state = "easy";
    if (score >= 75) state = "ready";
    else if (score < 55) state = "rest";

    return {
      readinessScore: score,
      state,
      reasons,
      hrvToday,
      rhrToday,
      stepsAvg,
      vo2,
      vo2Info
    };
  }

  MW.computeReadinessFromSnapshots = MW.computeReadinessFromSnapshots || computeReadinessFromSnapshots;

  // -----------------------------
  // Version + export
  // -----------------------------
  MW.version = MW.version || "1.0.0";

  window.mwCore = MW;

})();
