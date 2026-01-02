// src/merge/precedenceMerge.js
// Clinic (CONNEQT) ALWAYS overrides wearable BP on the same day_key.
// Non-destructive: returns a new snapshot object.
// No API contract changes: only sets existing bpSystolic/bpDiastolic.

function qualityRank(q) {
    if (q === "high") return 3;
    if (q === "medium") return 2;
    if (q === "low") return 1;
    return 0;
}

function pickBest(rows) {
    if (!rows || !rows.length) return null;
    return [...rows].sort((a, b) => {
        const q = qualityRank(b.quality) - qualityRank(a.quality);
        if (q !== 0) return q;
        const ta = a.measured_at ? Date.parse(a.measured_at) : 0;
        const tb = b.measured_at ? Date.parse(b.measured_at) : 0;
        return tb - ta;
    })[0];
}

function buildAnchorIndex({ conneqtRows = [] } = {}) {
    const conneqtByDay = {};
    for (const r of conneqtRows) {
        const dk = r.day_key;
        if (!dk) continue;
        (conneqtByDay[dk] ||= []).push(r);
    }
    return { conneqtByDay };
}

function dayKeyFromSnapshot(snapshot) {
    if (!snapshot) return null;
    // Prefer explicit day_key if present
    if (snapshot.day_key) return snapshot.day_key;

    // Your API snapshots have `date` like "2025-12-08T18:56:28.863+00:00"
    if (snapshot.date) return String(snapshot.date).slice(0, 10);

    return null;
}

function mergeSnapshotWithAnchors(snapshot, anchorIndex) {
    const out = { ...snapshot };

    const dk = dayKeyFromSnapshot(snapshot);
    if (!dk) return out;

    const conneqtRows = (anchorIndex.conneqtByDay && anchorIndex.conneqtByDay[dk]) || [];
    const conneqt = pickBest(conneqtRows);
    if (!conneqt) return out;

    const sys = conneqt.brachial_systolic;
    const dia = conneqt.brachial_diastolic;
    if (sys == null || dia == null) return out;

    // ALWAYS override if clinic BP exists for that day
    out.bpSystolic = sys;
    out.bpDiastolic = dia;

    return out;
}

module.exports = {
    buildAnchorIndex,
    mergeSnapshotWithAnchors,
    dayKeyFromSnapshot,
};