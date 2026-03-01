# Vitaliage Watch App - Integration Guide

Complete guide for integrating the Apple Watch companion app with the iOS Vitaliage app.

## Prerequisites

1. **Xcode 15.0+** with watchOS 10.0+ SDK
2. **iOS App Setup**: Both targets must have:
   - Same Team ID
   - App Groups capability enabled
   - HealthKit capability enabled
3. **Watch Pair**: Physical watch paired with iPhone or simulator setup

## Step 1: Setup App Groups

### iOS Target

1. Open project in Xcode
2. Select iOS app target → Signing & Capabilities
3. Click "+ Capability"
4. Add "App Groups"
5. Enter: `group.com.vitaliage.watch`

### watchOS Target

1. Select Watch app target → Signing & Capabilities
2. Add "App Groups" capability
3. Use same group: `group.com.vitaliage.watch`

## Step 2: Configure HealthKit Capabilities

### iOS Target

Already configured in `HealthKitService.swift`. Verify Info.plist has:

```xml
<key>NSHealthShareUsageDescription</key>
<string>Vitaliage needs access to your health data to calculate readiness and track wellness metrics.</string>
<key>NSHealthClinicalHealthRecordsShareUsageDescription</key>
<string>Vitaliage uses health records for comprehensive wellness analysis.</string>
```

### watchOS Target

Add to watchOS `Info.plist`:

```xml
<key>NSHealthShareUsageDescription</key>
<string>Vitaliage Watch needs access to your health data for metrics.</string>
```

## Step 3: Enable WatchConnectivity

### Both Targets

1. Select target → Signing & Capabilities
2. Add capability: "Watch Connectivity"

No additional configuration needed - `WatchConnectivityService` handles setup.

## Step 4: Copy and Adapt iOS Models

The watchOS app uses simplified data models. Copy compatible portions from iOS app:

From `/ios-views/`:

1. **Models** - If you have additional models beyond those in `WatchModels.swift`
2. **API Client** - For server sync if needed
3. **Utilities** - Helper functions for formatting, colors, etc.

Example:

```swift
// In watchOS, import iOS models if shared:
// import VitaliageCore  // Your shared framework

// Or copy/adapt locally:
struct ReadinessData: Codable {
    let score: Int
    let band: ReadinessBand
    // ... as in WatchModels.swift
}
```

## Step 5: iOS App - Send Data to Watch

Add this method to your iOS `DeviceDashboardViewModel` or similar:

```swift
import WatchConnectivity

class WatchSyncManager {
    static let shared = WatchSyncManager()

    func sendReadinessToWatch(
        score: Int,
        band: String,
        reasons: [String],
        confidence: Double?
    ) {
        guard WCSession.default.activationState == .activated else {
            print("Watch not available")
            return
        }

        let readinessDict: [String: Any] = [
            "score": score,
            "band": band,
            "reasons": reasons,
            "confidence": confidence as Any,
            "timestamp": Date().timeIntervalSince1970
        ]

        let context: [String: Any] = [
            "readiness": readinessDict,
            "timestamp": Date().timeIntervalSince1970
        ]

        do {
            try WCSession.default.updateApplicationContext(context)
        } catch {
            print("Error sending to watch: \(error)")
        }
    }

    func sendInsightsToWatch(_ insights: [String]) {
        guard WCSession.default.activationState == .activated else { return }

        do {
            try WCSession.default.updateApplicationContext([
                "insights": insights,
                "timestamp": Date().timeIntervalSince1970
            ])
        } catch {
            print("Error sending insights: \(error)")
        }
    }
}
```

### Integration Point in iOS App

In your iOS readiness calculation flow:

```swift
// After calculating readiness
let band = calculateReadinessBand(score: readinessScore)
WatchSyncManager.shared.sendReadinessToWatch(
    score: Int(readinessScore),
    band: band,
    reasons: readinessReasons,
    confidence: confidenceScore
)
```

### WCSessionDelegate Implementation in iOS

Add to your iOS app's main view or AppDelegate:

```swift
import WatchConnectivity

class AppDelegate: UIResponder, UIApplicationDelegate, WCSessionDelegate {

    override init() {
        super.init()
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    // MARK: - WCSessionDelegate

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        DispatchQueue.main.async {
            if activationState == .activated {
                print("Watch app activated")
                // Send latest data to watch
                self.syncLatestDataToWatch()
            }
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {
        print("Watch session inactive")
    }

    func sessionDidDeactivate(_ session: WCSession) {
        WCSession.default.activate()
    }

    // Receive message from Watch
    func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        if message["requestReadiness"] as? Bool == true {
            // Send latest readiness to watch
            let response = getCurrentReadinessDict()
            replyHandler(response)
        }
    }

    private func syncLatestDataToWatch() {
        // Get current readiness from your view model/service
        if let readiness = getCurrentReadiness() {
            WatchSyncManager.shared.sendReadinessToWatch(
                score: readiness.score,
                band: readiness.band,
                reasons: readiness.reasons,
                confidence: readiness.confidence
            )
        }
    }

    private func getCurrentReadiness() -> ReadinessData? {
        // Get from your active view model
        // This is app-specific; adapt to your architecture
        return nil
    }

    private func getCurrentReadinessDict() -> [String: Any] {
        if let readiness = getCurrentReadiness() {
            return [
                "readiness": [
                    "score": readiness.score,
                    "band": readiness.band,
                    "confidence": readiness.confidence as Any
                ]
            ]
        }
        return [:]
    }
}
```

## Step 6: Build and Test

### Simulator Setup

1. **Start iOS Simulator** → iPhone model
2. **Start watchOS Simulator** → Watch model
3. Pair in Watch app:
   - On iPhone simulator, open Watch app
   - Swipe down → "Unpaired Watch"
   - Tap "Pair"
4. **In Xcode**: Target → Run destination: "iPhone... + Watch ..."

### Physical Device

1. Pair Apple Watch with iPhone normally
2. On iPhone:
   - Open Watch app
   - Go to Privacy → Health
   - Enable Vitaliage
3. Install watchOS app via Xcode:
   - Xcode → Product → Scheme → Select Watch App
   - Product → Destination → Your Watch
   - Run

### Testing Flow

1. **iOS App**:
   - Open on iPhone
   - Simulate/fetch readiness score
   - Call `WatchSyncManager.shared.sendReadinessToWatch(...)`

2. **Watch App**:
   - Launch Vitaliage Watch app
   - Should see "Connecting..." initially
   - Once synced, readiness gauge shows score
   - Tap metrics to see trends

3. **Complications**:
   - Add to watch face in Watch app on iPhone
   - Should show cached data immediately
   - Update every 15-30 minutes

4. **Pull to Refresh**:
   - Swipe down on Watch dashboard
   - Should fetch fresh HealthKit data
   - Readiness updates if iPhone is reachable

## Step 7: Share Models (Optional)

For cleaner architecture, create a shared framework:

### Create Shared Framework

1. File → New → Target → Framework
2. Name: `VitaliageCore`
3. Add to both iOS and watchOS targets

### Move Shared Code

Move to `VitaliageCore`:
- `WatchModels.swift` data structures
- Color helpers
- Formatting utilities
- API models

### Update Imports

In watchOS app:

```swift
import VitaliageCore  // Instead of duplicating models
```

## Step 8: Handle Data Caching

Watch complications cache data via UserDefaults with app group:

```swift
@AppStorage("readinessScore", store: UserDefaults(suiteName: "group.com.vitaliage.watch"))
var cachedScore: Int = 0
```

iOS app should update this cache when syncing:

```swift
extension WatchSyncManager {
    func updateWatchCache(readiness: ReadinessData) {
        let userDefaults = UserDefaults(suiteName: "group.com.vitaliage.watch")!
        userDefaults.set(readiness.score, forKey: "readinessScore")
        userDefaults.set(readiness.band.rawValue, forKey: "readinessBand")
    }
}
```

## Step 9: Configuration Customization

### App Group Identifier

If using different identifier, update all occurrences:

```swift
// In WatchConnectivityService
let defaults = UserDefaults(suiteName: "group.YOUR.BUNDLE.ID")!

// In iOS sync code
let userDefaults = UserDefaults(suiteName: "group.YOUR.BUNDLE.ID")!

// In Widget complications
@AppStorage(..., store: UserDefaults(suiteName: "group.YOUR.BUNDLE.ID"))
```

### Refresh Intervals

Adjust in timeline providers:

```swift
// In ReadinessProvider
let refreshDate = Calendar.current.date(byAdding: .minute, value: 15, to: now)!
```

Options:
- Readiness: 30 minutes (sync from iPhone)
- Steps: 15 minutes (local HealthKit)
- Heart Rate: 20 minutes (local HealthKit)
- Status Indicator: 30 minutes

### Metrics to Display

In `WatchDashboardView`, toggle metrics:

```swift
// Show/hide metrics
#if SHOW_VO2_MAX
    NavigationLink(destination: MetricDetailView(metricType: .vo2Max)) {
        // ...
    }
#endif
```

## Step 10: Testing Checklist

- [ ] App Groups capability enabled on both targets
- [ ] HealthKit capability enabled on both targets
- [ ] WatchConnectivity capability enabled
- [ ] Info.plist has HealthKit descriptions
- [ ] iOS app sends readiness to Watch
- [ ] Watch app receives and displays readiness
- [ ] HealthKit queries work on Watch
- [ ] Complications show cached data offline
- [ ] Pull-to-refresh updates metrics
- [ ] Tap metric shows detail view with trends
- [ ] WatchConnectivity reconnects after timeout
- [ ] Error handling shows gracefully

## Troubleshooting

### App Groups Not Working

**Problem**: Watch can't access iOS cached data

**Solution**:
```bash
# Verify bundle identifiers match in both targets
# iOS: com.yourcompany.vitaliage
# Watch: com.yourcompany.vitaliage.watchkit

# Both should use app group:
# group.com.yourcompany.vitaliage.watch
```

### HealthKit Not Available on Watch

**Problem**: `fetchTodaySteps()` returns 0

**Solution**:
1. Check HealthKit permission in Watch app on iPhone
2. Ensure user has been active (some data present)
3. Check simulator has health data:
   - Watch app → Health → Add sample data

### WatchConnectivity Not Syncing

**Problem**: iPhone data not appearing on Watch

**Solution**:
1. Check both have internet/connectivity
2. Ensure `WCSession.default.isReachable`
3. Try calling `updateApplicationContext()` manually
4. Reinstall watch app
5. Restart watch

### Complications Not Updating

**Problem**: Widget shows stale data

**Solution**:
1. Check UserDefaults app group is correct
2. Verify timeline provider is being called:
   ```swift
   print("Timeline refresh called")  // Add logging
   ```
3. Force refresh:
   - Remove complication from watch face
   - Add back
   - Wait 15+ minutes or force refresh in simulator

### Memory Issues on Watch

**Problem**: App crashes on Watch

**Solution**:
1. Reduce stored history (keep 7 days max)
2. Don't cache large images
3. Use lightweight data structures
4. Profile with Instruments on real device

## Performance Tips

1. **Async HealthKit Queries**: All queries async, don't block UI
2. **Batch Updates**: Send one context update, not multiple
3. **Cache Aggressively**: Use UserDefaults for quick offline access
4. **Limit History**: Keep 7-30 days max, not years
5. **Lazy Loading**: Load metric details only when tapped

## Security Considerations

1. **HealthKit Data**: Never send over insecure connection
2. **UserDefaults**: Don't store sensitive tokens (use Keychain if needed)
3. **WatchConnectivity**: Only send non-sensitive health summaries
4. **App Group Access**: App Group only accessible by your app bundle IDs

## Next Steps

1. Run on simulator to verify basic functionality
2. Test on physical device with real watch pairing
3. Add additional metrics (VO2 Max, respiratory rate, etc.)
4. Implement notifications for readiness drops
5. Add Siri Shortcuts integration
6. Submit to App Store

## References

- [WatchConnectivity Guide](https://developer.apple.com/documentation/watchconnectivity/)
- [WidgetKit Best Practices](https://developer.apple.com/documentation/widgetkit/)
- [HealthKit on watchOS](https://developer.apple.com/documentation/healthkit/)
- [watchOS App Architecture](https://developer.apple.com/design/human-interface-guidelines/watchos/overview/)

## Contact & Support

For questions or issues integrating the Watch app:
1. Check console logs for errors
2. Review HealthKit/WatchConnectivity error callbacks
3. Test on both simulator and real device
4. Verify all capabilities are enabled
5. Ensure app group identifier is consistent
