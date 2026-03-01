import WidgetKit
import SwiftUI

/// Inline text complication showing today's step count.
struct StepsComplication: Widget {
    let kind: String = "StepsComplication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: StepsProvider()) { entry in
            StepsComplicationView(entry: entry)
        }
        .configurationDisplayName("Steps")
        .description("Today's step count")
        .supportedFamilies([.accessoryInline, .accessoryRectangular])
    }
}

// MARK: - Timeline Provider

struct StepsProvider: TimelineProvider {
    @AppStorage("todaySteps", store: UserDefaults(suiteName: "group.com.vitaliage.watch"))
    var cachedSteps: Int = 0

    func placeholder(in context: Context) -> StepsEntry {
        StepsEntry(date: Date(), steps: 5432)
    }

    func getSnapshot(in context: Context, completion: @escaping (StepsEntry) -> Void) {
        let entry = StepsEntry(date: Date(), steps: cachedSteps)
        completion(entry)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StepsEntry>) -> Void) {
        // Query HealthKit for today's steps
        let healthService = WatchHealthKitService.shared

        Task {
            do {
                let steps = try await healthService.fetchTodaySteps()
                let entry = StepsEntry(date: Date(), steps: steps)

                var entries: [StepsEntry] = [entry]

                // Refresh every 15 minutes
                let refreshDate = Calendar.current.date(byAdding: .minute, value: 15, to: Date())!
                let timeline = Timeline(entries: entries, policy: .after(refreshDate))

                completion(timeline)
            } catch {
                // Fallback to cached value
                let entry = StepsEntry(date: Date(), steps: cachedSteps)
                let timeline = Timeline(entries: [entry], policy: .never)
                completion(timeline)
            }
        }
    }
}

// MARK: - Timeline Entry

struct StepsEntry: TimelineEntry {
    let date: Date
    let steps: Int
}

// MARK: - Views

struct StepsComplicationView: View {
    @Environment(\.widgetRenderingMode) var renderingMode

    let entry: StepsEntry

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "figure.walk")
                .font(.caption)
                .foregroundColor(.blue)

            Text(formatSteps(entry.steps))
                .lineLimit(1)
        }
    }

    private func formatSteps(_ steps: Int) -> String {
        if steps >= 10000 {
            return String(format: "%.1fk", Double(steps) / 1000)
        } else if steps >= 1000 {
            return String(format: "%.1fk", Double(steps) / 1000)
        }
        return "\(steps)"
    }
}

#Preview(as: .accessoryInline) {
    StepsComplication()
} timeline: {
    StepsEntry(date: Date(), steps: 7234)
    StepsEntry(date: Date().addingTimeInterval(600), steps: 7456)
}
