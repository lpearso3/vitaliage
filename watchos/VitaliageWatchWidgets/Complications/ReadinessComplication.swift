import WidgetKit
import SwiftUI

/// Circular gauge showing readiness score (0-100) with color-coded status.
struct ReadinessComplication: Widget {
    let kind: String = "ReadinessComplication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ReadinessProvider()) { entry in
            ReadinessComplicationView(entry: entry)
        }
        .configurationDisplayName("Readiness")
        .description("Your daily readiness score")
        .supportedFamilies([.accessoryCircular, .accessoryInline])
    }
}

// MARK: - Timeline Provider

struct ReadinessProvider: TimelineProvider {
    @AppStorage("readinessScore", store: UserDefaults(suiteName: "group.com.vitaliage.watch"))
    var cachedScore: Int = 0

    @AppStorage("readinessBand", store: UserDefaults(suiteName: "group.com.vitaliage.watch"))
    var cachedBand: String = "good"

    func placeholder(in context: Context) -> ReadinessEntry {
        ReadinessEntry(date: Date(), score: 75, band: .good)
    }

    func getSnapshot(in context: Context, completion: @escaping (ReadinessEntry) -> Void) {
        let entry = ReadinessEntry(
            date: Date(),
            score: cachedScore,
            band: parseBand(cachedBand)
        )
        completion(entry)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ReadinessEntry>) -> Void) {
        // Fetch latest readiness from iPhone via WatchConnectivity
        var entries: [ReadinessEntry] = []

        let now = Date()
        let entry = ReadinessEntry(
            date: now,
            score: cachedScore,
            band: parseBand(cachedBand)
        )
        entries.append(entry)

        // Refresh every 30 minutes
        let refreshDate = Calendar.current.date(byAdding: .minute, value: 30, to: now)!
        let timeline = Timeline(entries: entries, policy: .after(refreshDate))

        completion(timeline)
    }

    private func parseBand(_ band: String) -> ReadinessData.ReadinessBand {
        switch band.lowercased() {
        case "excellent":
            return .excellent
        case "good":
            return .good
        case "fair":
            return .fair
        case "poor":
            return .poor
        default:
            return .good
        }
    }
}

// MARK: - Timeline Entry

struct ReadinessEntry: TimelineEntry {
    let date: Date
    let score: Int
    let band: ReadinessData.ReadinessBand
}

// MARK: - Views

struct ReadinessComplicationView: View {
    @Environment(\.widgetRenderingMode) var renderingMode

    let entry: ReadinessEntry

    var body: some View {
        Group {
            if renderingMode == .accented {
                // Circular complication with accent color
                ZStack {
                    Circle()
                        .stroke(Color(.systemGray4), lineWidth: 3)

                    Circle()
                        .trim(from: 0, to: CGFloat(entry.score) / 100.0)
                        .stroke(
                            readinessColor(entry.band),
                            style: StrokeStyle(lineWidth: 3, lineCap: .round)
                        )
                        .rotationEffect(.degrees(-90))

                    VStack(spacing: 0) {
                        Text("\(entry.score)")
                            .font(.system(size: 16, weight: .bold, design: .rounded))
                        Text("100")
                            .font(.system(size: 8, weight: .regular))
                    }
                }
            } else {
                // Tinted circular complication
                ZStack {
                    Circle()
                        .fill(Color(.systemGray5))

                    Circle()
                        .trim(from: 0, to: CGFloat(entry.score) / 100.0)
                        .stroke(
                            readinessColor(entry.band),
                            style: StrokeStyle(lineWidth: 3, lineCap: .round)
                        )
                        .rotationEffect(.degrees(-90))

                    VStack(spacing: 0) {
                        Text("\(entry.score)")
                            .font(.system(size: 14, weight: .bold, design: .rounded))
                        Text("100")
                            .font(.system(size: 8, weight: .regular))
                    }
                    .foregroundColor(readinessColor(entry.band))
                }
            }
        }
    }

    private func readinessColor(_ band: ReadinessData.ReadinessBand) -> Color {
        switch band {
        case .excellent:
            return .green
        case .good:
            return .cyan
        case .fair:
            return .yellow
        case .poor:
            return .red
        }
    }
}

#Preview(as: .accessoryCircular) {
    ReadinessComplication()
} timeline: {
    ReadinessEntry(date: Date(), score: 75, band: .good)
    ReadinessEntry(date: Date().addingTimeInterval(600), score: 78, band: .excellent)
}
