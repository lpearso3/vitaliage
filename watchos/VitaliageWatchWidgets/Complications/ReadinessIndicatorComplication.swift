import WidgetKit
import SwiftUI

/// Small circular complication showing readiness status with colored dot.
struct ReadinessIndicatorComplication: Widget {
    let kind: String = "ReadinessIndicatorComplication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ReadinessIndicatorProvider()) { entry in
            ReadinessIndicatorComplicationView(entry: entry)
        }
        .configurationDisplayName("Readiness Status")
        .description("Quick readiness indicator")
        .supportedFamilies([.accessoryCircular, .accessoryCorner])
    }
}

// MARK: - Timeline Provider

struct ReadinessIndicatorProvider: TimelineProvider {
    @AppStorage("readinessBand", store: UserDefaults(suiteName: "group.com.vitaliage.watch"))
    var cachedBand: String = "good"

    func placeholder(in context: Context) -> ReadinessIndicatorEntry {
        ReadinessIndicatorEntry(date: Date(), band: .good)
    }

    func getSnapshot(in context: Context, completion: @escaping (ReadinessIndicatorEntry) -> Void) {
        let entry = ReadinessIndicatorEntry(date: Date(), band: parseBand(cachedBand))
        completion(entry)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ReadinessIndicatorEntry>) -> Void) {
        let entry = ReadinessIndicatorEntry(date: Date(), band: parseBand(cachedBand))

        var entries: [ReadinessIndicatorEntry] = [entry]

        // Refresh every 30 minutes
        let refreshDate = Calendar.current.date(byAdding: .minute, value: 30, to: Date())!
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

struct ReadinessIndicatorEntry: TimelineEntry {
    let date: Date
    let band: ReadinessData.ReadinessBand
}

// MARK: - Views

struct ReadinessIndicatorComplicationView: View {
    @Environment(\.widgetRenderingMode) var renderingMode

    let entry: ReadinessIndicatorEntry

    var body: some View {
        Group {
            if renderingMode == .accented {
                // Circular indicator with colored dot
                ZStack {
                    Circle()
                        .fill(Color(.systemGray5))

                    VStack(spacing: 2) {
                        Circle()
                            .fill(bandColor(entry.band))
                            .frame(width: 8, height: 8)

                        Text(bandAbbreviation(entry.band))
                            .font(.system(size: 10, weight: .semibold))
                    }
                }
            } else {
                // Corner indicator
                ZStack(alignment: .bottomTrailing) {
                    Circle()
                        .fill(Color(.systemGray5))

                    Circle()
                        .fill(bandColor(entry.band))
                        .frame(width: 12, height: 12)
                        .offset(x: 2, y: 2)
                }
            }
        }
    }

    private func bandColor(_ band: ReadinessData.ReadinessBand) -> Color {
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

    private func bandAbbreviation(_ band: ReadinessData.ReadinessBand) -> String {
        switch band {
        case .excellent:
            return "E"
        case .good:
            return "G"
        case .fair:
            return "F"
        case .poor:
            return "P"
        }
    }
}

#Preview(as: .accessoryCircular) {
    ReadinessIndicatorComplication()
} timeline: {
    ReadinessIndicatorEntry(date: Date(), band: .excellent)
    ReadinessIndicatorEntry(date: Date().addingTimeInterval(600), band: .good)
}
