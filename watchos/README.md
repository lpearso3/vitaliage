# Vitaliage Apple Watch Companion App

Complete watchOS companion app and complications for the Vitaliage iOS health/wellness platform.

## Directory Structure

```
watchos/
├── VitaliageWatch/
│   ├── Models/
│   │   └── WatchModels.swift          # Data models for Watch
│   ├── Services/
│   │   ├── WatchHealthKitService.swift      # Local HealthKit queries on Watch
│   │   └── WatchConnectivityService.swift   # iPhone-Watch sync via WatchConnectivity
│   ├── Views/
│   │   ├── WatchDashboardView.swift   # Main watch face dashboard
│   │   └── MetricDetailView.swift     # Detail view for single metric
│   └── VitaliageWatchApp.swift        # Main app entry point
│
└── VitaliageWatchWidgets/
    ├── VitaliageWidgetBundle.swift     # Widget bundle configuration
    └── Complications/
        ├── ReadinessComplication.swift              # Circular gauge (0-100)
        ├── StepsComplication.swift                  # Inline step count
        ├── HeartRateComplication.swift              # Corner heart rate
        └── ReadinessIndicatorComplication.swift     # Status dot indicator
```

## Components

### Main App (`VitaliageWatchApp.swift`)

**Entry Point**
- `@main` decorated App struct
- Initializes HealthKit permissions on launch
- Shows error view if authorization fails
- Displays WatchDashboardView on success

**Features**
- Async authorization request
- Error handling for permission denial
- Single NavigationView wrapping dashboard

### Views

#### WatchDashboardView

**Main Watch Face Dashboard**

Displays:
1. **Readiness Gauge** (top, circular 0-100)
   - Color-coded: Green (Excellent) → Cyan (Good) → Yellow (Fair) → Red (Poor)
   - Animated progress ring
   - Current score and band label
   - Taps show nothing (main focus area)

2. **Metrics Grid** (4 key metrics)
   - Steps (figure.walk icon, blue)
   - Resting Heart Rate (heart.fill icon, red)
   - Heart Rate Variability (waveform.path.ecg icon, purple)
   - Sleep (bed.double.fill icon, green)
   - Each tile is tappable → MetricDetailView

3. **Sync Status** (bottom)
   - Connection indicator (iPhone connected/offline)
   - Last sync timestamp
   - Error messages if any

**Features**
- Pull-to-refresh capability
- Auto-refresh on appearance
- Asynchronous data loading
- Fallback to cached values

#### MetricDetailView

**Single Metric Detail Screen**

For each metric (Steps, HR, HRV, Sleep):

1. **Current Value Card**
   - Large display with unit
   - Prominent font for readability

2. **Trend Indicator**
   - Icon showing direction (↗ improving, → stable, ↘ declining)
   - Label and descriptive text
   - Color-coded (green/gray/red)

3. **7-Day Trend Chart**
   - Canvas-based bar chart
   - Min/Max labels
   - Responsive to data range

4. **Summary Stats**
   - Current value
   - 7-day average
   - Calculated trend based on first vs. second half

**Data Sources**
- Steps: HealthKit daily cumulative
- Heart Rate: HealthKit latest sample
- HRV: HealthKit latest SDNN sample
- Sleep: HealthKit last night's duration

### Services

#### WatchHealthKitService

**Local HealthKit Queries on Watch**

Supported metrics:
- Steps (today & 7 days)
- Resting Heart Rate (latest & 7 days average)
- Heart Rate Variability (latest & 7 days average)
- Sleep (last night & 7 days)

**Methods**
- `requestAuthorization()` - Request read permissions
- `fetchTodaySteps()` - Today's cumulative steps
- `fetchLatestRestingHeartRate()` - Latest HR sample
- `fetchLatestHRV()` - Latest HRV (SDNN)
- `fetchLastNightSleep()` - Sleep minutes from yesterday
- `fetchSevenDaysSteps()` - Historical daily steps
- `fetchSevenDaysHeartRate()` - Historical daily HR average
- `fetchSevenDaysHRV()` - Historical daily HRV average
- `fetchSevenDaysSleep()` - Historical daily sleep

**Notes**
- HealthKit is available directly on watchOS 4.0+
- Queries run on Watch (no iPhone required for local data)
- Uses async/await with CheckedThrowingContinuation
- Simplified subset compared to iOS (watch-appropriate metrics only)

#### WatchConnectivityService

**iPhone-Watch Real-Time Sync**

**Responsibilities**
- Bidirectional communication with iPhone
- Receives readiness scores and insights from iPhone
- Falls back to local HealthKit if iPhone unavailable
- Updates local cache via UserDefaults with app group

**Methods**
- `requestReadinessFromPhone()` - Ask iPhone for latest readiness
- `sendWatchMetricsToPhone()` - Send Watch's HealthKit data to iPhone
- `isPhoneReachable()` - Check connectivity status

**WCSessionDelegate Implementation**
- `session(_:activationDidCompleteWith:error:)` - Handle activation
- `session(_:didReceiveApplicationContext:)` - Receive from iPhone
- `session(_:didReceive:)` - Handle file transfers

**Features**
- Automatic activation in `setupWatchConnectivity()`
- Main dispatch queue updates for SwiftUI
- Graceful degradation if iPhone unreachable
- App group UserDefaults for shared caching

### Data Models (`WatchModels.swift`)

**HealthMetric**
- `value: Double` - Numeric metric value
- `unit: String` - Display unit (bpm, steps, etc.)
- `trend: MetricTrend` - improving/stable/declining
- `timestamp: Date`
- `displayValue: String`
- Computed properties: `trendIcon`, `trendColor`

**ReadinessData**
- `score: Int` (0-100)
- `band: ReadinessBand` (excellent/good/fair/poor)
- `reasons: [String]` - Why score is this level
- `confidence: Double?` (0-1)
- `lastUpdated: Date`
- Band color mapping

**DailySnapshot**
- `date: Date`
- `steps: Int`
- `restingHeartRate: Int?`
- `heartRateVariability: Double?`
- `sleepMinutes: Int?`
- `readiness: ReadinessData?`
- Computed: `sleepHours`

**MetricHistory**
- For charting trends
- `metricType` (steps/heartRate/hrv/sleep)
- `values: [HistoricalValue]` with date and value
- `averageValue`, `minValue`, `maxValue`

**WatchSyncData**
- Data synced from iPhone
- Readiness, insights, care plan items
- Sync timestamp

## Complications (WidgetKit)

Four WidgetKit complications for Watch face complications. Uses modern WidgetKit (not deprecated ClockKit).

### ReadinessComplication

**Circular gauge with 0-100 score**

- **Families**: `.accessoryCircular`, `.accessoryInline`
- **Display**: Animated progress ring with score in center
- **Colors**: Band-based (green/cyan/yellow/red)
- **Refresh**: Every 30 minutes
- **Rendering Mode**: Supports both accented and tinted

```
┌─────────────┐
│   ┌──────┐  │
│  ╱        ╲ │
│ │    75    │ │
│  ╲   /100╱ │
│   └──────┘  │
│  Excellent  │
└─────────────┘
```

### StepsComplication

**Inline text showing today's step count**

- **Families**: `.accessoryInline`, `.accessoryRectangular`
- **Display**: Icon + step count (formatted with k for thousands)
- **Color**: Blue
- **Refresh**: Every 15 minutes
- **Data Source**: HealthKit (cached via UserDefaults)

```
🚶 7.2k
```

### HeartRateComplication

**Corner complication with latest heart rate**

- **Families**: `.accessoryCorner`, `.accessoryInline`
- **Display**: Heart rate value with small heart icon
- **Color**: Red
- **Refresh**: Every 20 minutes
- **Format**: "72 bpm"

```
  ┌─────────┐
  │    72   │
  │   bpm❤  │
  └─────────┘
```

### ReadinessIndicatorComplication

**Small colored dot for quick status**

- **Families**: `.accessoryCircular`, `.accessoryCorner`
- **Display**: Colored dot indicating band (E/G/F/P)
- **Colors**: Excellent→Green, Good→Cyan, Fair→Yellow, Poor→Red
- **Refresh**: Every 30 minutes
- **Use Case**: Minimal real estate status indicator

```
  ┌─────┐
  │  🟢  │
  │  G   │
  └─────┘
```

## Widget Bundle Configuration

File: `VitaliageWidgetBundle.swift`

Registers all four complications using modern `@main WidgetBundle` pattern:

```swift
@main
struct VitaliageWidgetBundle: WidgetBundle {
    var body: some Widget {
        ReadinessComplication()
        StepsComplication()
        HeartRateComplication()
        ReadinessIndicatorComplication()
    }
}
```

## Architecture Patterns

### Async/Await with HealthKit

All HealthKit queries use Swift Concurrency:

```swift
func fetchTodaySteps() async throws -> Int {
    // Uses withCheckedThrowingContinuation to bridge callback-based API
}
```

### Observation and Binding

Services use `@ObservableObject` and `@Published`:

```swift
@ObservedObject var healthService = WatchHealthKitService.shared
@ObservedObject var connectivityService = WatchConnectivityService.shared
```

### State Management

Data flows:
- Watch queries HealthKit locally
- Requests readiness from iPhone via WatchConnectivity
- Falls back to cached values if iPhone unavailable
- Updates UI via @State and @Published

### Caching Strategy

- UserDefaults with app group: `"group.com.vitaliage.watch"`
- Stores: readiness score, band, steps, heart rate
- Complications read cached values for offline operation
- Fresh data fetched on timeline refresh

## Integration with iOS App

### iPhone → Watch

The iOS app should:
1. Send readiness scores via `WCSession.default.updateApplicationContext()`
2. Include format:
   ```swift
   [
       "readiness": ["score": 75, "band": "good", "confidence": 0.85],
       "insights": ["Getting enough sleep", "HR stable"],
       "carePlan": ["Continue current routine"]
   ]
   ```

### Watch → iPhone

Watch sends:
- Daily snapshot (steps, HR, HRV, sleep)
- Triggered manually or on app launch
- Uses `sendMessage()` with reply handler

## Usage Notes

### For Developers

1. **Setup App Group**: Add app group to both iOS and watchOS targets
2. **HealthKit Permissions**: Add to Watch target Info.plist:
   ```xml
   <key>NSHealthShareUsageDescription</key>
   <string>Access health data for readiness scoring</string>
   ```
3. **WatchConnectivity**: Automatic via WCSession delegation
4. **Complications**: Register in WatchKit app settings on iPhone

### For Users

- Watch runs independently but syncs with iPhone when available
- Pull-to-refresh on dashboard updates all metrics
- Complications show cached data even offline
- Readiness score syncs when iPhone is nearby
- Detailed metric views show 7-day trends

## Colors and Design

**SF Symbols Used**
- `figure.walk` - Steps (blue)
- `heart.fill` - Heart rate (red)
- `waveform.path.ecg` - HRV (purple)
- `bed.double.fill` - Sleep (green)
- `iphone.radiowaves.left.and.right` - Connected (green)
- `iphone.slash` - Offline (orange)

**Color Scheme**
- Readiness bands: Green/Cyan/Yellow/Red
- System colors for accessibility
- Accent color for primary actions

**Typography**
- Headlines: `.system(size: 28, weight: .bold, design: .rounded)`
- Captions: `.caption` and `.caption2`
- Watch-optimized font sizes

## Testing

### Preview Providers

Each view includes `#Preview` with sample data:

```swift
#Preview {
    MetricDetailView(
        metricType: .steps,
        currentValue: 7234,
        displayUnit: "steps"
    )
}
```

Complications include timeline previews with multiple entries.

### Manual Testing

1. **Simulator**: watchOS simulator paired with iOS simulator
2. **Device**:
   - Ensure app is installed on both iPhone and Watch
   - Use "Paired Apple Watch" in Xcode
   - Manually trigger complications on watch face
3. **Offline Testing**: Toggle iPhone connectivity in Watch app settings

## Performance Considerations

- **HealthKit Queries**: Run async, don't block UI
- **Complications**: Use cached data, refresh every 15-30 minutes
- **WatchConnectivity**: Batches updates, fallback to cache
- **Memory**: Watch OS has tight constraints; only essential data cached

## Future Enhancements

1. **Activity Rings**: Add Activity/Exercise rings display
2. **Workout Integration**: Show active workout metrics
3. **Notifications**: Send alerts for readiness drops
4. **Settings**: Allow metric preferences per complication
5. **More Complications**: VO2 Max, respiratory rate, etc.
6. **Siri Shortcuts**: Add voice commands for quick access
7. **Persistent Storage**: Use Core Data for longer history

## Troubleshooting

### Complications Not Showing Data

- Check app group is same in iOS and watchOS targets
- Verify HealthKit permissions requested in app
- Ensure WCSession is activated

### HealthKit Authorization Fails

- Add NSHealthShareUsageDescription to Info.plist
- Verify capability is enabled on both targets

### WatchConnectivity Not Syncing

- Enable WatchConnectivity in capabilities
- Ensure iPhone app is foreground or background app refresh enabled
- Check that devices are paired and nearby

## References

- [WidgetKit Documentation](https://developer.apple.com/documentation/widgetkit/)
- [WatchConnectivity](https://developer.apple.com/documentation/watchconnectivity/)
- [HealthKit on watchOS](https://developer.apple.com/documentation/healthkit)
- [watchOS Design Guidelines](https://developer.apple.com/design/human-interface-guidelines/watchos)
