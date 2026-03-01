import SwiftUI

/// Detail view for a single metric showing current value, trend, and 7-day history.
struct MetricDetailView: View {
    @ObservedObject var healthService = WatchHealthKitService.shared

    let metricType: MetricType
    let currentValue: Double
    let displayUnit: String

    @State private var trendData: [(date: Date, value: Double)] = []
    @State private var trend: HealthMetric.MetricTrend = .stable
    @State private var isLoading = false

    enum MetricType {
        case steps
        case heartRate
        case hrv
        case sleep
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // Current Value
                currentValueCard

                // Trend Indicator
                trendIndicator

                // Mini Chart
                if !trendData.isEmpty {
                    chartView
                }

                // Status Summary
                statusSummary
            }
            .padding()
        }
        .navigationTitle(metricTitle)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            Task {
                await loadTrendData()
            }
        }
    }

    // MARK: - Current Value Card

    private var currentValueCard: some View {
        VStack(spacing: 8) {
            Text(metricTitle)
                .font(.caption)
                .foregroundColor(.secondary)

            HStack(alignment: .lastTextBaseline, spacing: 4) {
                Text(formatValue(currentValue))
                    .font(.system(size: 36, weight: .bold, design: .rounded))

                Text(displayUnit)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .frame(maxWidth: .infinity)
        .padding()
        .background(Color(.systemGray6))
        .cornerRadius(12)
    }

    // MARK: - Trend Indicator

    private var trendIndicator: some View {
        HStack(spacing: 12) {
            Image(systemName: trend.trendIcon)
                .font(.headline)
                .foregroundColor(trendColor(trend))

            VStack(alignment: .leading, spacing: 2) {
                Text(trendLabel(trend))
                    .font(.headline)

                Text(trendDescription(trend))
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.systemGray6))
        .cornerRadius(12)
    }

    // MARK: - Chart View

    private var chartView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("7-Day Trend")
                .font(.caption)
                .foregroundColor(.secondary)
                .padding(.horizontal)

            Canvas { context in
                let maxValue = trendData.map(\.value).max() ?? currentValue
                let minValue = trendData.map(\.value).min() ?? 0
                let range = maxValue - minValue > 0 ? maxValue - minValue : 1

                let width = 200.0
                let height = 80.0
                let barWidth = width / Double(trendData.count)

                // Draw bars
                for (index, data) in trendData.enumerated() {
                    let normalized = (data.value - minValue) / range
                    let barHeight = normalized * height
                    let x = Double(index) * barWidth
                    let y = height - barHeight

                    var path = Path()
                    path.addRect(CGRect(x: x, y: y, width: barWidth - 2, height: barHeight))

                    let color = Color.accentColor
                    context.fill(path, with: .color(color))
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 80)
            .background(Color(.systemGray6))
            .cornerRadius(8)
            .padding(.horizontal)

            // Min/Max labels
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Min")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    Text(formatValue(trendData.map(\.value).min() ?? 0))
                        .font(.caption)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    Text("Max")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    Text(formatValue(trendData.map(\.value).max() ?? currentValue))
                        .font(.caption)
                }
            }
            .padding(.horizontal)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.systemGray6))
        .cornerRadius(12)
    }

    // MARK: - Status Summary

    private var statusSummary: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Summary")
                .font(.caption)
                .foregroundColor(.secondary)

            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Current")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    Text(formatValue(currentValue))
                        .font(.headline)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    Text("Avg (7 days)")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    if !trendData.isEmpty {
                        let avg = trendData.map(\.value).reduce(0, +) / Double(trendData.count)
                        Text(formatValue(avg))
                            .font(.headline)
                    } else {
                        Text("—")
                            .font(.headline)
                    }
                }
            }
            .padding()
            .background(Color(.systemGray5))
            .cornerRadius(8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.systemGray6))
        .cornerRadius(12)
    }

    // MARK: - Data Loading

    @MainActor
    private func loadTrendData() async {
        isLoading = true
        defer { isLoading = false }

        do {
            switch metricType {
            case .steps:
                let data = try await healthService.fetchSevenDaysSteps()
                trendData = data.map { (date: $0.date, value: Double($0.steps)) }

            case .heartRate:
                let data = try await healthService.fetchSevenDaysHeartRate()
                trendData = data.map { (date: $0.date, value: $0.bpm) }

            case .hrv:
                let data = try await healthService.fetchSevenDaysHRV()
                trendData = data.map { (date: $0.date, value: $0.hrv) }

            case .sleep:
                let data = try await healthService.fetchSevenDaysSleep()
                trendData = data.map { (date: $0.date, value: Double($0.minutes) / 60.0) }
            }

            // Calculate trend
            if trendData.count > 1 {
                let oldAvg = trendData.prefix(trendData.count / 2).map(\.value).reduce(0, +) / Double(trendData.count / 2)
                let newAvg = trendData.suffix(trendData.count / 2).map(\.value).reduce(0, +) / Double(trendData.count / 2)

                if newAvg > oldAvg * 1.05 {
                    trend = .improving
                } else if newAvg < oldAvg * 0.95 {
                    trend = .declining
                } else {
                    trend = .stable
                }
            }
        } catch {
            print("Error loading trend data: \(error)")
        }
    }

    // MARK: - Helpers

    private var metricTitle: String {
        switch metricType {
        case .steps:
            return "Steps"
        case .heartRate:
            return "Resting Heart Rate"
        case .hrv:
            return "Heart Rate Variability"
        case .sleep:
            return "Sleep"
        }
    }

    private func formatValue(_ value: Double) -> String {
        switch metricType {
        case .steps:
            if value >= 1000 {
                return String(format: "%.1fk", value / 1000)
            }
            return String(Int(value))

        case .heartRate:
            return String(Int(value))

        case .hrv:
            return String(Int(value))

        case .sleep:
            return String(format: "%.1f", value)
        }
    }

    private func trendLabel(_ trend: HealthMetric.MetricTrend) -> String {
        switch trend {
        case .improving:
            return "Improving"
        case .stable:
            return "Stable"
        case .declining:
            return "Declining"
        }
    }

    private func trendDescription(_ trend: HealthMetric.MetricTrend) -> String {
        switch trend {
        case .improving:
            return "Keep it up!"
        case .stable:
            return "Consistent"
        case .declining:
            return "Watch for changes"
        }
    }

    private func trendColor(_ trend: HealthMetric.MetricTrend) -> Color {
        switch trend {
        case .improving:
            return .green
        case .stable:
            return .gray
        case .declining:
            return .red
        }
    }
}

// MARK: - Preview

#Preview {
    NavigationStack {
        MetricDetailView(
            metricType: .steps,
            currentValue: 7234,
            displayUnit: "steps"
        )
    }
}
