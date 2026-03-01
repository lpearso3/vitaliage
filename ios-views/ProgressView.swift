import SwiftUI

// MARK: - Progress View Models

struct MetricComparison: Identifiable {
    let id = UUID()
    let name: String
    let icon: String
    let color: Color
    let firstVisitValue: String
    let firstVisitDate: Date
    let currentValue: String
    let currentDate: Date
    let unit: String
    let isImproving: Bool
    let changePercent: Double?
}

// MARK: - Main Progress Dashboard View

struct ProgressView: View {
    let userId: String
    @State private var selectedTimeWindow: TimeWindow = .days90
    @State private var showBiologicalAgeDetail = false
    @State private var biologicalAge = 45
    @State private var chronologicalAge = 52
    @State private var confidence = 0.92
    @State private var lastUpdated = Calendar.current.date(byAdding: .day, value: -3, to: Date())!

    @State private var metricComparisons: [MetricComparison] = []
    @State private var isLoading = true

    enum TimeWindow: String, CaseIterable {
        case days30 = "30 days"
        case days90 = "90 days"
        case days180 = "180 days"
        case allTime = "All time"

        var days: Int? {
            switch self {
            case .days30: return 30
            case .days90: return 90
            case .days180: return 180
            case .allTime: return nil
            }
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Hero biological age card
                    biologicalAgeHero

                    // Time window selector
                    timeWindowSelector

                    // Before/After comparison section
                    beforeAfterSection

                    // More sections can go here
                }
                .padding()
            }
            .navigationTitle("Your Progress")
            .navigationBarTitleDisplayMode(.inline)
            .task { await loadProgressData() }
            .refreshable { await loadProgressData() }
            .sheet(isPresented: $showBiologicalAgeDetail) {
                BiologicalAgeDetailView(
                    chronologicalAge: chronologicalAge,
                    biologicalAge: biologicalAge,
                    confidence: confidence,
                    lastUpdated: lastUpdated,
                    contributors: sampleContributors(),
                    historicalAges: sampleHistoricalAges()
                )
            }
        }
    }

    // MARK: - Biological Age Hero Card

    private var biologicalAgeHero: some View {
        VStack(spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("You're \(chronologicalAge), but your body is \(biologicalAge)")
                        .font(.headline)
                    HStack(spacing: 6) {
                        Image(systemName: "info.circle")
                            .font(.caption2)
                        Text("Updated \(relativeTimeString(lastUpdated))")
                            .font(.caption)
                    }
                    .foregroundStyle(.secondary)
                }

                Spacer()

                // Large delta display
                VStack(alignment: .trailing, spacing: 4) {
                    HStack(spacing: 4) {
                        Image(systemName: biologicalAge < chronologicalAge ? "arrow.down.right" : "arrow.up.right")
                            .font(.caption)
                        Text("\(abs(biologicalAge - chronologicalAge))")
                            .font(.system(size: 24, weight: .bold, design: .rounded))
                    }
                    .foregroundStyle(biologicalAge < chronologicalAge ? .green : .orange)

                    Text("years")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            // Confidence indicator
            HStack(spacing: 8) {
                Image(systemName: "shield.checkered")
                    .font(.caption2)
                    .foregroundStyle(.green)
                Text("Confidence: \(String(format: "%.0f%%", confidence * 100))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // Tap to see breakdown
            Button {
                showBiologicalAgeDetail = true
            } label: {
                HStack {
                    Text("See detailed breakdown")
                        .font(.subheadline.bold())
                    Image(systemName: "arrow.right")
                        .font(.caption)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(Color.accentColor.opacity(0.1))
                .foregroundStyle(.accentColor)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(16)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    // MARK: - Time Window Selector

    private var timeWindowSelector: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Time Period")
                .font(.headline)

            Picker("Time Window", selection: $selectedTimeWindow) {
                ForEach(TimeWindow.allCases, id: \.self) { window in
                    Text(window.rawValue).tag(window)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: selectedTimeWindow) { _, _ in
                Task { await loadProgressData() }
            }
        }
    }

    // MARK: - Before/After Section

    private var beforeAfterSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Metric Improvements")
                .font(.headline)

            if metricComparisons.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "chart.bar")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text("No data available")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(40)
            } else {
                VStack(spacing: 12) {
                    ForEach(metricComparisons) { metric in
                        metricComparisonCard(metric)
                    }
                }
            }
        }
    }

    // MARK: - Metric Comparison Card

    private func metricComparisonCard(_ metric: MetricComparison) -> some View {
        VStack(spacing: 12) {
            HStack {
                Image(systemName: metric.icon)
                    .font(.title3)
                    .foregroundStyle(metric.color)
                    .frame(width: 40, height: 40)
                    .background(metric.color.opacity(0.15))
                    .clipShape(Circle())

                VStack(alignment: .leading, spacing: 2) {
                    Text(metric.name)
                        .font(.headline)
                    Text(metric.unit)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                // Change indicator
                if let changePercent = metric.changePercent {
                    VStack(alignment: .trailing, spacing: 2) {
                        HStack(spacing: 4) {
                            Image(systemName: metric.isImproving ? "arrow.up.right" : "arrow.down.right")
                                .font(.caption)
                            Text(String(format: "%.1f%%", abs(changePercent)))
                                .font(.subheadline.bold())
                        }
                        .foregroundStyle(metric.isImproving ? .green : .red)
                    }
                }
            }

            // Before/After values
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("First Visit")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(metric.firstVisitValue)
                        .font(.headline)
                    Text(dateFormatter(metric.firstVisitDate))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(12)
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "arrow.right")
                    .foregroundStyle(.secondary)

                VStack(alignment: .trailing, spacing: 6) {
                    Text("Now")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(metric.currentValue)
                        .font(.headline)
                    Text(dateFormatter(metric.currentDate))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(12)
                .background(metric.isImproving ? Color.green.opacity(0.1) : Color.red.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(16)
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.05), radius: 8, y: 4)
    }

    // MARK: - Data Loading

    private func loadProgressData() async {
        isLoading = true

        // Sample data - replace with actual API call
        let sampleComparisons = [
            MetricComparison(
                name: "VO2 Max",
                icon: "lungs.fill",
                color: .orange,
                firstVisitValue: "42.0",
                firstVisitDate: Calendar.current.date(byAdding: .month, value: -6, to: Date())!,
                currentValue: "48.5",
                currentDate: Date(),
                unit: "ml/kg/min",
                isImproving: true,
                changePercent: 15.5
            ),
            MetricComparison(
                name: "Body Fat %",
                icon: "figure.stand",
                color: .pink,
                firstVisitValue: "28.2%",
                firstVisitDate: Calendar.current.date(byAdding: .month, value: -6, to: Date())!,
                currentValue: "23.5%",
                currentDate: Date(),
                unit: "percent",
                isImproving: true,
                changePercent: -16.7
            ),
            MetricComparison(
                name: "Resting Heart Rate",
                icon: "heart.fill",
                color: .red,
                firstVisitValue: "68 bpm",
                firstVisitDate: Calendar.current.date(byAdding: .month, value: -6, to: Date())!,
                currentValue: "58 bpm",
                currentDate: Date(),
                unit: "beats/min",
                isImproving: true,
                changePercent: -14.7
            ),
            MetricComparison(
                name: "HRV (SDNN)",
                icon: "waveform.path.ecg",
                color: .purple,
                firstVisitValue: "42 ms",
                firstVisitDate: Calendar.current.date(byAdding: .month, value: -6, to: Date())!,
                currentValue: "52 ms",
                currentDate: Date(),
                unit: "milliseconds",
                isImproving: true,
                changePercent: 23.8
            ),
            MetricComparison(
                name: "Grip Strength",
                icon: "hand.raised.fill",
                color: .yellow,
                firstVisitValue: "48 kg",
                firstVisitDate: Calendar.current.date(byAdding: .month, value: -6, to: Date())!,
                currentValue: "52 kg",
                currentDate: Date(),
                unit: "kilograms",
                isImproving: true,
                changePercent: 8.3
            ),
            MetricComparison(
                name: "6-Minute Walk",
                icon: "figure.walk",
                color: .cyan,
                firstVisitValue: "520 m",
                firstVisitDate: Calendar.current.date(byAdding: .month, value: -6, to: Date())!,
                currentValue: "580 m",
                currentDate: Date(),
                unit: "meters",
                isImproving: true,
                changePercent: 11.5
            ),
        ]

        await MainActor.run {
            metricComparisons = sampleComparisons
            isLoading = false
        }
    }

    // MARK: - Sample Data Helpers

    private func sampleContributors() -> [BiologicalAgeContributor] {
        [
            BiologicalAgeContributor(
                name: "VO2 Max",
                icon: "lungs.fill",
                yearOffset: -3.0,
                actualValue: "48 ml/kg/min",
                populationAverage: "42",
                unit: "ml/kg/min",
                color: .green
            ),
            BiologicalAgeContributor(
                name: "HRV",
                icon: "waveform.path.ecg",
                yearOffset: -1.5,
                actualValue: "52 ms",
                populationAverage: "45",
                unit: "ms",
                color: .green
            ),
            BiologicalAgeContributor(
                name: "Resting HR",
                icon: "heart.fill",
                yearOffset: 0.5,
                actualValue: "58 bpm",
                populationAverage: "60",
                unit: "bpm",
                color: .orange
            ),
            BiologicalAgeContributor(
                name: "Inflammation",
                icon: "flame.fill",
                yearOffset: -2.0,
                actualValue: "0.8 mg/L",
                populationAverage: "2.0",
                unit: "mg/L",
                color: .green
            ),
            BiologicalAgeContributor(
                name: "Body Composition",
                icon: "figure.stand",
                yearOffset: 1.0,
                actualValue: "24% body fat",
                populationAverage: "23%",
                unit: "%",
                color: .red
            ),
            BiologicalAgeContributor(
                name: "Sleep Quality",
                icon: "moon.fill",
                yearOffset: -0.5,
                actualValue: "7.2 hrs/night",
                populationAverage: "6.8",
                unit: "hrs",
                color: .green
            ),
        ]
    }

    private func sampleHistoricalAges() -> [BiologicalAgeSnapshot] {
        (0..<6).map { i -> BiologicalAgeSnapshot in
            let date = Calendar.current.date(byAdding: .month, value: -i, to: Date())!
            return BiologicalAgeSnapshot(date: date, biologicalAge: 45 + i)
        }.reversed()
    }

    // MARK: - Helpers

    private func relativeTimeString(_ date: Date) -> String {
        let calendar = Calendar.current
        let now = Date()

        if calendar.isDateInToday(date) {
            return "today"
        } else if calendar.isDateInYesterday(date) {
            return "yesterday"
        } else {
            let components = calendar.dateComponents([.day], from: date, to: now)
            if let days = components.day, days < 7 {
                return "\(days) days ago"
            } else if let days = components.day, days < 30 {
                let weeks = days / 7
                return "\(weeks) week\(weeks > 1 ? "s" : "") ago"
            } else {
                let formatter = DateFormatter()
                formatter.dateFormat = "MMM d"
                return formatter.string(from: date)
            }
        }
    }

    private func dateFormatter(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d, yy"
        return formatter.string(from: date)
    }
}

// MARK: - Preview

#Preview {
    ProgressView(userId: "user-123")
}
