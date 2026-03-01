# Vitaliage Watch App - Quick Start Guide

Get the Apple Watch companion app up and running in 15 minutes.

## TL;DR - 5 Steps to Launch

1. **Add App Groups** (5 min)
   - iOS target: Signing & Capabilities → App Groups → `group.com.vitaliage.watch`
   - Watch target: Same app group

2. **Enable Capabilities** (2 min)
   - Both targets: Add HealthKit, WatchConnectivity

3. **Copy Watch Folder** (1 min)
   ```bash
   cp -r watchos/VitaliageWatch/* your_xcode_watch_target/
   cp -r watchos/VitaliageWatchWidgets/* your_xcode_widgets_target/
   ```

4. **Add iPhone Sync** (4 min)
   - In iOS app, add code to send readiness to watch (see Integration Guide)
   - Implement `WCSessionDelegate`

5. **Run** (3 min)
   - Xcode: Scheme → Select Watch App
   - Run on simulator or device

## File Checklist

### Required Files (13 total)

**Core App**
- [ ] `VitaliageWatchApp.swift`
- [ ] `WatchDashboardView.swift`
- [ ] `MetricDetailView.swift`
- [ ] `WatchHealthKitService.swift`
- [ ] `WatchConnectivityService.swift`
- [ ] `WatchModels.swift`

**Complications**
- [ ] `VitaliageWidgetBundle.swift`
- [ ] `ReadinessComplication.swift`
- [ ] `StepsComplication.swift`
- [ ] `HeartRateComplication.swift`
- [ ] `ReadinessIndicatorComplication.swift`

**Documentation**
- [ ] `README.md`
- [ ] `INTEGRATION_GUIDE.md`

## Key Code Snippets

### 1. Enable HealthKit (Info.plist)

```xml
<key>NSHealthShareUsageDescription</key>
<string>Vitaliage needs access to your health data</string>
```

### 2. Create App Group (Xcode)

Both iOS and watchOS targets:
```
Signing & Capabilities → + Capability → App Groups
Add: group.com.vitaliage.watch
```

### 3. Send Readiness from iPhone

```swift
import WatchConnectivity

// In iOS app
func sendReadinessToWatch(score: Int, band: String) {
    let context: [String: Any] = [
        "readiness": [
            "score": score,
            "band": band
        ]
    ]
    try? WCSession.default.updateApplicationContext(context)
}
```

### 4. Implement WCSessionDelegate (iOS)

```swift
class AppDelegate: UIResponder, WCSessionDelegate {
    override init() {
        super.init()
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) {
        WCSession.default.activate()
    }

    func session(_ session: WCSession,
                 activationDidCompleteWith state: WCSessionActivationState,
                 error: Error?) {
        // Watch app is ready
    }
}
```

### 5. Test on Simulator

```bash
# Start iOS simulator
open /Applications/Xcode.app/Contents/Developer/Applications/Simulator.app

# In Xcode
Product → Scheme → Select Watch App
Product → Destination → iPhone 15 + Apple Watch Series 9
Product → Run
```

## Features at a Glance

### Dashboard (Main Screen)
```
┌─────────────────────┐
│   Readiness Gauge   │  ← 0-100 circular score
│    (Green/Yellow)   │
├─────────────────────┤
│ 🚶  🫀  📊  😴      │  ← 4 metrics (tap for details)
│ Steps HR HRV Sleep  │
├─────────────────────┤
│ Connected to iPhone │  ← Sync status
└─────────────────────┘
```

### Metric Details (Tap any metric)
```
┌─────────────────────┐
│ Steps               │
│ 7,234               │  ← Current value
├─────────────────────┤
│ ↗ Improving         │  ← Trend
├─────────────────────┤
│ [Chart bars]        │  ← 7-day chart
│ Min: 2k  Max: 8.5k  │
├─────────────────────┤
│ Avg: 6.1k           │  ← Statistics
└─────────────────────┘
```

### Complications (Watch Face)
- **Readiness**: Large circular gauge (0-100)
- **Steps**: Text "7.2k" with walk icon
- **Heart Rate**: "72 bpm" in corner
- **Status**: Colored dot (green/yellow/red)

## Common Issues & Fixes

| Problem | Solution |
|---------|----------|
| App Groups not working | Verify both targets use same identifier: `group.com.vitaliage.watch` |
| HealthKit permission denied | Add `NSHealthShareUsageDescription` to watchOS Info.plist |
| Complications show "—" | Ensure app group is correct; data might be cached from previous run |
| Watch app crashes on launch | Check HealthKit capability is enabled |
| iPhone data not syncing | Ensure WCSession.default.activate() called on iPhone; watch must be nearby |

## Architecture Quick Reference

**Services** (Handle all data)
- `WatchHealthKitService` - Local watch health data
- `WatchConnectivityService` - iPhone communication

**Views** (Display data)
- `WatchDashboardView` - Main screen
- `MetricDetailView` - Detail screens

**Models** (Data structures)
- `DailySnapshot` - Day's metrics
- `ReadinessData` - Readiness score + band
- `HealthMetric` - Individual metric

**Complications** (Watch face widgets)
- Readiness, Steps, Heart Rate, Status

## Default Configurations

| Setting | Value | Change |
|---------|-------|--------|
| App Group | `group.com.vitaliage.watch` | Search & replace |
| Readiness Refresh | 30 minutes | ReadinessProvider |
| Steps Refresh | 15 minutes | StepsProvider |
| HR Refresh | 20 minutes | HeartRateProvider |
| Status Refresh | 30 minutes | ReadinessIndicatorProvider |
| Trend History | 7 days | MetricDetailView |

## Development Workflow

### 1. Edit Code
```swift
// Edit any Swift file
nano VitaliageWatch/Views/WatchDashboardView.swift
```

### 2. Build
```bash
# In Xcode: Product → Build
# Or: Cmd + B
```

### 3. Run on Simulator
```bash
# Xcode: Product → Run
# Or: Cmd + R
```

### 4. Test Complications
```
On Watch simulator:
1. Force press (long press on simulator)
2. Swipe to "Add..."
3. Select Vitaliage complication
4. Tap to add to watch face
```

### 5. Manually Refresh Timeline
```
# In Xcode simulator
# Pause and resume to force update
# Or wait for refresh interval
```

## Debugging Tips

### Check Console Logs
```
Product → View → Consoles → Debug Console
Look for print() statements and errors
```

### HealthKit Data Not Appearing
```
watchOS Simulator:
1. Open Watch app on iPhone simulator
2. Go to Health
3. Manually add sample data
4. Wait 30 seconds
5. Run Watch app again
```

### WatchConnectivity Not Working
```
1. Verify pairing in Watch app
2. Check both targets have WatchConnectivity capability
3. Print WCSession.default.isReachable
4. Verify updateApplicationContext() is called
5. Restart simulators if stuck
```

### Complication Not Updating
```
1. Check app group is correct
2. Verify timeline provider is being called
3. Force app to foreground then background
4. Remove complication and re-add
5. Wait for refresh interval (15-30 min)
```

## Performance Checklist

- [ ] HealthKit queries use async/await (not blocking)
- [ ] WatchConnectivity uses background threads (not main)
- [ ] Views refresh only when data changes
- [ ] History limited to 7 days maximum
- [ ] No large images stored or cached
- [ ] UserDefaults cached for offline operation

## Security Checklist

- [ ] No sensitive tokens in UserDefaults
- [ ] HealthKit only reads (never writes)
- [ ] WatchConnectivity only sends summaries (not raw data)
- [ ] App Group only accessible by your app
- [ ] No hardcoded API keys or secrets

## Next Steps

1. **Read** `README.md` for architecture overview
2. **Follow** `INTEGRATION_GUIDE.md` for iOS integration
3. **Check** `PROJECT_STRUCTURE.md` for file details
4. **Build** and test on simulator
5. **Deploy** to physical watch via Xcode

## Getting Help

1. Check console logs: Product → View → Consoles
2. Review README.md troubleshooting section
3. Check INTEGRATION_GUIDE.md for sync issues
4. Verify all capabilities are enabled
5. Ensure app group identifier is consistent

## Useful Commands

```bash
# Clear simulator data
xcrun simctl erase all

# List simulator devices
xcrun simctl list

# Launch specific simulator
open /Applications/Xcode.app/Contents/Developer/Applications/Simulator.app

# Check app group access
defaults read "~/Library/Group Containers/group.com.vitaliage.watch"
```

## Files Quick Reference

| File | Lines | Purpose |
|------|-------|---------|
| VitaliageWatchApp.swift | 50 | App entry point |
| WatchDashboardView.swift | 350 | Main screen |
| MetricDetailView.swift | 350 | Detail screens |
| WatchHealthKitService.swift | 400 | Health queries |
| WatchConnectivityService.swift | 250 | iPhone sync |
| WatchModels.swift | 150 | Data models |
| VitaliageWidgetBundle.swift | 15 | Widget setup |
| *Complications.swift | 130-150 ea | Watch widgets |

## Success Criteria

You've successfully built the Watch app when:

- [ ] Watch app builds without errors
- [ ] App launches on watch simulator
- [ ] Dashboard shows "Connecting..." initially
- [ ] Pull-to-refresh fetches HealthKit data
- [ ] Metrics display (steps, HR, HRV, sleep)
- [ ] Tapping metric shows detail view with chart
- [ ] Complications appear on watch face
- [ ] Complications update every 15-30 minutes
- [ ] Offline mode works (cached data shows)
- [ ] iPhone sync works when nearby
- [ ] No crashes or crashes logged in console

## Time Estimates

| Task | Time | Note |
|------|------|------|
| Setup app groups | 5 min | Xcode UI |
| Enable capabilities | 2 min | Both targets |
| Copy files | 1 min | File system |
| iOS integration | 10 min | Add sync code |
| First build | 3 min | Xcode |
| Test on simulator | 5 min | Basic flow |
| **Total** | **~25 min** | End-to-end |

## Questions?

Refer to:
- **Setup issues?** → INTEGRATION_GUIDE.md
- **Architecture?** → README.md
- **File locations?** → PROJECT_STRUCTURE.md
- **Code details?** → Individual source files
- **Features?** → README.md Feature section

---

**You're ready to build!** Start with step 1 above.
