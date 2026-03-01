import WidgetKit
import SwiftUI

/// Corner complication showing latest heart rate with heart icon.
struct HeartRateComplication: Widget {
    let kind: String = "HeartRateComplication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: HeartRateProvider()) { entry in
            HeartRateComplicationView(entry: entry)
        }
        .configurationDisplayName("Heart Rate")
        .description("Latest resting heart rate")
        .supportedFamilies([.accessoryCorner, .accessoryInline])
    }
}

// MARK: - Timeline Provider

struct HeartRateProvider: TimelineProvider {
    @AppStorage("latestHeartRate", store: UserDefaults(suiteName: "group.com.vitaliage.watch"))
    var cachedHeartRate: Int = 0

    func placeholder(in context: Context) -> HeartRateEntry {
        HeartRateEntry(date: Date(), heartRate: 72)
    }

    func getSnapshot(in context: Context, completion: @escaping (HeartRateEntry) -> Void) {
        let entry = HeartRateEntry(date: Date(), heartRate: cachedHeartRate)
        completion(entry)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<HeartRateEntry>) -> Void) {
        // Query HealthKit for latest heart rate
        let healthService = WatchHealthKitService.shared

        Task {
            do {
                let hr = try await healthService.fetchLatestRestingHeartRate()
                let entry = HeartRateEntry(date: Date(), heartRate: hr ?? cachedHeartRate)

                var entries: [HeartRateEntry] = [entry]

                // Refresh every 20 minutes
                let refreshDate = Calendar.current.date(byAdding: .minute, value: 20, to: Date())!
                let timeline = Timeline(entries: entries, policy: .after(refreshDate))

                completion(timeline)
            } catch {
                // Fallback to cached value
                let entry = HeartRateEntry(date: Date(), heartRate: cachedHeartRate)
                let timeline = Timeline(entries: [entry], policy: .never)
                completion(timeline)
            }
        }
    }
}

// MARK: - Timeline Entry

struct HeartRateEntry: TimelineEntry {
    let date: Date
    let heartRate: Int
}

// MARK: - Views

struct HeartRateComplicationView: View {
    @Environment(\.widgetRenderingMode) var renderingMode

    let entry: HeartRateEntry

    var body: some View {
        Group {
            if renderingMode == .accented {
                // Corner complication
                ZStack(alignment: .bottomTrailing) {
                    // Background circle
                    Circle()
                        .fill(Color(.systemGray5))

                    // Heart rate text
                    VStack(alignment: .center, spacing: 1) {
                        Text("\(entry.heartRate)")
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                        Text("bpm")
                            .font(.system(size: 8, weight: .regular))
                    }
                    .offset(x: -4, y: -8)

                    // Heart icon in corner
                    Image(systemName: "heart.fill")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.red)
                        .offset(x: -2, y: -2)
                }
            } else {
                // Inline complication
                HStack(spacing: 4) {
                    Image(systemName: "heart.fill")
                        .font(.caption2)
                        .foregroundColor(.red)

                    Text("\(entry.heartRate)")
                        .lineLimit(1)
                        .font(.caption)

                    Text("bpm")
                        .font(.system(size: 8))
                        .foregroundColor(.secondary)
                }
            }
        }
    }
}

#Preview(as: .accessoryCorner) {
    HeartRateComplication()
} timeline: {
    HeartRateEntry(date: Date(), heartRate: 72)
    HeartRateEntry(date: Date().addingTimeInterval(600), heartRate: 70)
}
