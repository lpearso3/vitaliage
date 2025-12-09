// mw-core.js
(function () {
  const MW = window.mwCore || {};

  // -----------------------------
  // Settings helpers
  // -----------------------------
  const SETTINGS_KEY = 'mw_settings';
  const DEV_KEY = 'mw_dev_cfg';

  function getSettingsSafe() {
    try {
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

  // -----------------------------
  // Profile + VO2 helpers
  // -----------------------------
  function getProfile() {
    const s = getSettingsSafe();
    const p = (s && s.profile) || {};

    let age = null;
    let sex = null;
    let trainingLevel = null;

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

    return {
      age: age || 45,
      sex: sex || "female",
      trainingLevel: trainingLevel || "recreational",
    };
  }

  MW.getProfile = MW.getProfile || getProfile;

  function resolveProfileForVo2() {
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

  let _snapshotCache = null;
  let _snapshotCacheTs = 0;

  async function getSnapshots(limit) {
    const n = typeof limit === "number" && limit > 0 ? limit : 7;

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

    return list;
  }

  MW.getSnapshots = MW.getSnapshots || getSnapshots;

  // -----------------------------
  // Readiness scoring
  // -----------------------------
  function computeReadinessScore(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    const s = snapshot;

    let sleepScore = 70;
    if (s.sleep && s.sleep.totalMinutes && s.sleep.goalMinutes) {
      const pct = (s.sleep.totalMinutes / s.sleep.goalMinutes) * 100;
      sleepScore = Math.max(0, Math.min(100, pct));
    }

    let hrvScore = 70;
    if (typeof s.hrv === "number" && s.hrv > 0) {
      const pct = (s.hrv / 60) * 100;
      hrvScore = Math.max(0, Math.min(100, pct));
    }

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
  // Export
  // -----------------------------
  window.mwCore = MW;

})();
