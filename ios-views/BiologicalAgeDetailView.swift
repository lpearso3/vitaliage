import SwiftUI
import Charts

// MARK: - Biological Age Models

struct BiologicalAgeContributor: Identifiable {
    let id = UUID()
    let name: String
    let icon: String
    let yearOffset: Double
    let actualValue: String
    let populationAverage: String
    let unit: String
    let color: Color
}

struct BiologicalAgeSnapshot: Identifiable {
    let id = UUID()
    let date: Date
    let biologicalAge: Int
}

// MARK: - Biological Age Detail View

struct BiologicalAgeDetailView: View {
    let chronologicalAge: Int
    let biologicalAge: Int
    let confidence: Double
    let lastUpdated: Date
    let contributors: [BiologicalAgeContributor]
    let historicalAges: [BiologicalAgeSnapshot]

    var ageDelta: Int {
        biologicalAge - chronologicalAge
    }

    var ageDeltaLabel: String {
        if ageDelta < 0 {
            return "You're \(abs(ageDelta)) years younger"
        } else if ageDelta > 0 {
            return "You're \(ageDelta) years older"
        } else {
            return "You're right on track"
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Hero circular display
                    VStack(spacing: 16) {
                        ZStack {
                            Circle()
                                .stroke(Color(.systemGray4), lineWidth: 12)
                                .frame(width: 200, height: 200)

                            VStack(spacing: 8) {
                                Text("Biological Age")
                                    .font(.headline)
                                    .foregroundStyle(.secondary)

                                HStack(spacing: 8, alignment: .top) {
                                    VStack(spacing: 2) {
                                        Text("\(biologicalAge)")
                                            .font(.system(size: 56, weight: .bold, design: .rounded))
                                        Text("years")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }

                                    VStack(alignment: .leading, spacing: 8) {
                                        HStack(spacing: 4) {
                                            Text("vs")
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                            Text("\(chronologicalAge)")
                                                .font(.headline)
                                        }

                                        HStack(spacing: 2) {
                                            Image(systemName: ageDelta < 0 ? "arrow.down.right" : "arrow.up.right")
                                                .font(.caption)
                                            Text("\(abs(ageDelta))")
                                                .font(.caption.bold())
                                        }
                                        .foregroundStyle(ageDelta < 0 ? .green : .red)
                                    }
                                }
                            }
                        }

                        Text(ageDeltaLabel)
                            .font(.subheadline)
                            .foregroundStyle(ageDelta < 0 ? .green : .orange)
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(20)
                    .background(.ultraThinMaterial)
                    .cornerRadius(20)

                    // Confidence indicator
                    VStack(spacing: 8) {
                        HStack {
                            Label("Confidence Level", systemImage: "shield.checkered")
                                .font(.headline)
                            Spacer()
                            Text(String(format: "%.0f%%", confidence * 100))
                                .font(.headline)
                                .foregroundStyle(.green)
                        }

                        ProgressView(value: confidence)
                            .tint(.green)

                        HStack {
                            Image(systemName: "info.circle")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text("Based on 6 key health factors")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding()
                    .background(Color(.systemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 16))

                    // Last updated
                    HStack {
                        Image(systemName: "clock")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("Updated \(relativeTimeString(lastUpdated))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .center)

                    // Contributors breakdown
                    VStack(alignment: .leading, spacing: 16) {
                        Text("What's affecting your age")
                            .font(.headline)

                        VStack(spacing: 12) {
                            ForEach(contributors) { contributor in
                                contributorCard(contributor)
                            }
                        }
                    }

                    // Historical trend
                    if !historicalAges.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Biological Age Trend")
                                .font(.headline)

                            Chart(historicalAges) { snapshot in
                                LineMark(
                                    x: .value("Month", snapshot.date),
                                    y: .value("Age", snapshot.biologicalAge)
                                )
                                .foregroundStyle(.blue)
                                .lineStyle(StrokeStyle(lineWidth: 2))

                                AreaMark(
                                    x: .value("Month", snapshot.date),
                                    y: .value("Age", snapshot.biologicalAge)
                                )
                                .foregroundStyle(Color.blue.opacity(0.15))

                                PointMark(
                                    x: .value("Month", snapshot.date),
                                    y: .value("Age", snapshot.biologicalAge)
                                )
                                .foregroundStyle(.blue)
                            }
                            .chartXAxis {
                                AxisMarks(values: .automatic) { value in
                                    AxisGridLine()
                                    AxisValueLabel {
                                        if let date = value.as(Date.self) {
                                            Text(monthFormatter(date))
                                                .font(.caption2)
                                        }
                                    }
                                }
                            }
                            .chartYAxis {
                                AxisMarks { value in
                                    AxisGridLine()
                                    AxisValueLabel {
                                        if let age = value.as(Int.self) {
                                            Text("\(age) yrs")
                                                .font(.caption2)
                                        }
                                    }
                                }
                            }
                            .frame(height: 220)
                        }
                        .padding()
                        .background(Color(.systemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                    }
                }
                .padding()
            }
            .navigationTitle("Biological Age")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    // MARK: - Contributor Card

    private func contributorCard(_ contributor: BiologicalAgeContributor) -> some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: contributor.icon)
                    .font(.title3)
                    .foregroundStyle(contributor.color)
                    .frame(width: 44, height: 44)
                    .background(contributor.color.opacity(0.15))
                    .clipShape(Circle())

                VStack(alignment: .leading, spacing: 4) {
                    Text(contributor.name)
                        .font(.headline)
                    Text(contributor.actualValue)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 4) {
                    HStack(spacing: 4) {
                        Image(systemName: contributor.yearOffset < 0 ? "minus" : "plus")
                            .font(.caption)
                        Text(String(format: "%.1f yr", abs(contributor.yearOffset)))
                            .font(.subheadline.bold())
                    }
                    .foregroundStyle(contributor.yearOffset < 0 ? .green : .red)

                    Text("Avg: \(contributor.populationAverage)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding()
            .background(Color(.systemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
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
                formatter.dateFormat = "MMM d, yyyy"
                return formatter.string(from: date)
            }
        }
    }

    private func monthFormatter(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM"
        return formatter.string(from: date)
    }
}

// MARK: - Preview

#Preview {
    let contributors = [
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
            name: "Inflammation (hs-CRP)",
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

    let historicalAges = (0..<6).map { i -> BiologicalAgeSnapshot in
        let date = Calendar.current.date(byAdding: .month, value: -i, to: Date())!
        return BiologicalAgeSnapshot(date: date, biologicalAge: 45 + i)
    }

    BiologicalAgeDetailView(
        chronologicalAge: 52,
        biologicalAge: 45,
        confidence: 0.92,
        lastUpdated: Calendar.current.date(byAdding: .day, value: -3, to: Date())!,
        contributors: contributors,
        historicalAges: historicalAges.reversed()
    )
}
