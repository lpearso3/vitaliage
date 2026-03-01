# VITALIAGE — BETA READINESS ASSESSMENT
## Generated Feb 28, 2026 from full iOS + backend code review

---

## CURRENT STATE SUMMARY

### Backend: SOLID ✅
- **Production parity verified** — `GET /resolved-bundle` returns correct shape
- **Contract validation** enforced at API boundary (runtime guards)
- **Readiness canonical** — `derived_metrics.readiness` live on prod
- **Confidence model locked** — `confidence.metrics` hard-rejected everywhere
- **bundle_hash deterministic** across identical inputs
- **userId now REQUIRED** on `/resolved-bundle` (enforced in server.js lines 206-214)

### iOS App: FUNCTIONAL BUT INCOMPLETE ⚠️
- **17 Swift files, ~2,000 lines** — small, focused codebase
- **Architecture is clean**: ViewModel + Services + DTOs + Views
- **Identity**: Keychain-persisted UUID via `UserIdentity.shared.userId` ✅
- **HealthKit**: Steps, resting HR, VO2 Max, 7-day sleep history ✅
- **Push**: APNs registration + device token upload ✅
- **Snapshot upload**: Posts to `/snapshot` endpoint ✅
- **ResolvedBundle fetch**: Calls `/resolved-bundle` with userId ✅
- **Readiness DTOs**: `DerivedMetricsDTO` + `ReadinessDTO` already defined ✅

---

## CRITICAL ISSUES TO FIX (Blocking Beta)

### Issue 1: ReadinessDTO field mismatch
**File:** `Models/DTOs.swift`
**Problem:** iOS `ReadinessDTO` has `band` field, but server returns `state`
```swift
// CURRENT (wrong):
struct ReadinessDTO: Codable {
    let score: Double?
    let band: String?     // ← server sends "state", not "band"
    let reasons: [String]?
}
```
**Fix:** Change `band` → `state` (or add CodingKeys mapping)
**Time:** 5 minutes

### Issue 2: No `/snapshot` endpoint on server
**File:** iOS `SnapshotApiClient.swift` line 87 + `APIConfig.swift`
**Problem:** iOS uploads snapshots to `POST /snapshot`, but server.js has NO `/snapshot` route. The server only has `/office/*` routes for staff-entered data.
**Impact:** Snapshot uploads silently fail → no wearable data in DB → readiness always shows "Not enough data"
**This is the #1 blocker.** Without wearable snapshots flowing into `daily_snapshots`, the entire pipeline produces empty results.
**Fix:** Add `POST /snapshot` (or `POST /daily-snapshots`) endpoint to server.js that writes to the `daily_snapshots` table
**Time:** 1-2 hours

### Issue 3: No `/daily-snapshots` GET endpoint on server
**File:** iOS `SnapshotApiClient.swift` line 120
**Problem:** iOS fetches from `GET /daily-snapshots` but server has no such route
**Impact:** `loadRemoteSnapshots()` will fail
**Fix:** Add `GET /daily-snapshots` endpoint (or remove from iOS since ResolvedBundle includes `daily_snapshots` array)
**Time:** 30 min - 1 hour

### Issue 4: ConfidenceDTO field mismatch
**File:** `Models/DTOs.swift`
**Problem:** iOS `ConfidenceOverallDTO` has `label` but server sends `grade`
```swift
// CURRENT (wrong):
struct ConfidenceOverallDTO: Codable {
    let score: Double?
    let label: String?    // ← server sends "grade", not "label"
}
```
**Fix:** Change `label` → `grade` (or add CodingKeys)
**Time:** 5 minutes

### Issue 5: DailySnapshotDTO upload shape mismatch
**File:** `Models/DTOs.swift`
**Problem:** iOS sends `userId` (camelCase) in snapshot JSON, but server `daily_snapshots` table expects `user_id` (snake_case). The upload endpoint doesn't exist yet (Issue 2), but when built, must handle this mapping.
**Time:** Handled as part of Issue 2

---

## NON-BLOCKING ISSUES (Fix Before or During Beta)

### Issue 6: HRV not wired
**File:** `DeviceDashboardViewModel.swift` line 193
```swift
hrv: nil,    // TODO: wire HRV when available
```
HRV is critical for readiness scoring (30% weight). Without it, readiness uses only sleep + resting HR + steps.
**Fix:** Add HRV fetch to `HealthKitService` (`.heartRateVariabilitySDNN`)
**Time:** 30-45 minutes

### Issue 7: UI shows only "Device Check" debug screen
**File:** `ContentView.swift`
The entire UI is a debug/test screen with raw metric tiles and "Send Snapshot to Test Endpoint" buttons. There is no user-facing dashboard showing readiness score, trends, or health insights.
**Impact:** Beta users will see a developer tool, not a product
**Fix:** Build a minimal beta dashboard (readiness card + key metrics + sleep chart)
**Time:** 3-5 hours for a clean minimal version

### Issue 8: No background sync
Snapshot uploads only happen when the user opens the app and HealthKit data loads. No background fetch or scheduled sync.
**Impact:** Data gaps if user doesn't open app daily
**Fix:** Add `BGAppRefreshTask` for daily snapshot upload
**Time:** 2-3 hours

### Issue 9: Sleep data uses fixed 8h goal on server
Server readiness uses `DEFAULT_SLEEP_GOAL_MIN = 480` (8 hours). iOS allows user to set 6h/7h/8h goal via picker, but this preference is never sent to the server.
**Impact:** Readiness sleep scoring may not match user expectation
**Fix:** Either send sleep goal with snapshot, or accept this as a known beta limitation
**Time:** 30 min if fixing, 0 if deferring

---

## BETA READINESS TASK LIST (Ordered)

| # | Task | Time | Priority |
|---|------|------|----------|
| 1 | **Add `POST /snapshot` endpoint to server.js** (writes to daily_snapshots) | 1-2h | CRITICAL |
| 2 | **Fix ReadinessDTO** (`band` → `state`) | 5 min | CRITICAL |
| 3 | **Fix ConfidenceOverallDTO** (`label` → `grade`) | 5 min | CRITICAL |
| 4 | **Wire HRV** in HealthKitService + snapshot | 45 min | HIGH |
| 5 | **Build minimal beta dashboard UI** (readiness card, metrics, sleep chart) | 3-5h | HIGH |
| 6 | **Add `GET /daily-snapshots` endpoint** OR remove iOS dependency | 30 min | MEDIUM |
| 7 | **Add background sync** (BGAppRefreshTask) | 2-3h | MEDIUM |
| 8 | **Beta user onboarding** (TestFlight setup, README for testers) | 1-2h | MEDIUM |
| 9 | **Observability** (structured log per bundle build, error log with user context) | 1h | LOW |

### Total estimated time: 10-15 hours

**Minimum viable beta (tasks 1-5 only): 5-8 hours**

---

## WHAT WORKS END-TO-END TODAY

1. App launches → generates stable UUID via Keychain ✅
2. App registers for push → sends device token to `/devices` ✅
3. App requests HealthKit → fetches steps, resting HR, VO2, sleep ✅
4. App builds `DailySnapshotDTO` from HealthKit data ✅
5. App calls `fetchResolvedBundle()` → gets readiness from server ✅

## WHAT IS BROKEN END-TO-END TODAY

1. ❌ Snapshot upload fails (no `/snapshot` endpoint on server)
2. ❌ No wearable data in `daily_snapshots` table → empty readiness
3. ❌ DTO field mismatches cause silent decode failures
4. ❌ No user-facing UI (only debug screen)
5. ❌ No background data sync

---

## RECOMMENDED NEXT SESSION START

Paste this into the new chat:

> "Resume Vitaliage beta work. Backend is solid (readiness canonical, contract enforced, prod verified). iOS app needs: (1) POST /snapshot endpoint on server to receive wearable data, (2) DTO field fixes (ReadinessDTO.band→state, ConfidenceOverallDTO.label→grade), (3) HRV wiring, (4) minimal beta dashboard UI. Start with the /snapshot endpoint — it's the #1 blocker."

---

## KEY IDENTIFIERS

- **App userId (test device):** `09da60ab-918e-4e11-8bb7-8e0fd6edc201`
- **Production URL:** `https://vitaliage.onrender.com`
- **Verified bundle_hash:** deterministic across identical inputs
- **iOS repo:** `/Users/metamorphosis/Desktop/Vitaliage`
- **Backend repo:** `/Users/metamorphosis/Vitaliage-push-api`
- **Supabase:** project may pause if inactive — resume before testing
