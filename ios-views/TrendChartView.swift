import SwiftUI
import Charts

// MARK: - Trend Data Models

struct TrendDataPoint: Identifiable {
    let id = UUID()
    let date: Date
    let value: Double
    let isClinicVisit: Bool
    let annotationLabel: String?
}

struct TrendChartAnnotation: Identifiable {
    let id = UUID()
    let date: Date
    let label: String
}

// MARK: - Trend Chart View

struct TrendChartView: View {
    let metricName: String
    let unit: String
    let dataPoints: [TrendDataPoint]
    let isImproving: Bool
    let timeWindow: TimeWindow

    enum TimeWindow {
        case days30
        case days90
        case days180
        case allTime

        var label: String {
            switch self {
            case .days30: return "30 days"
            case .days90: return "90 days"
            case .days180: return "180 days"
            case .allTime: return "All time"
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(metricName)
                        .font(.headline)
                    Text(timeWindow.label)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                // Trend badge
                if let latest = dataPoints.last, let previous = dataPoints.dropLast().last {
                    HStack(spacing: 4) {
                        Image(systemName: isImproving ? "arrow.up.right" : "arrow.down.right")
                            .font(.caption)
                        Text(String(format: "%.1f%s", latest.value, unit))
                            .font(.headline)
                    }
                    .foregroundStyle(isImproving ? .green : .red)
                }
            }

            // Chart
            if !dataPoints.isEmpty {
                Chart(dataPoints) { point in
                    LineMark(
                        x: .value("Date", point.date),
                        y: .value("Value", point.value)
                    )
                    .foregroundStyle(isImproving ? Color.green : Color.red)
                    .lineStyle(StrokeStyle(lineWidth: 2))

                    AreaMark(
                        x: .value("Date", point.date),
                        y: .value("Value", point.value)
                    )
                    .foregroundStyle(
                        (isImproving ? Color.green : Color.red)
                            .opacity(0.15)
                    )

                    // Clinic visit annotation
                    if point.isClinicVisit, let label = point.annotationLabel {
                        RuleMark(x: .value("Date", point.date))
                            .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                            .foregroundStyle(Color.gray.opacity(0.4))

                        PointMark(x: .value("Date", point.date), y: .value("Value", point.value))
                            .foregroundStyle(Color.gray)
                            .symbol(.circle)
                    } else {
                        PointMark(x: .value("Date", point.date), y: .value("Value", point.value))
                            .foregroundStyle(isImproving ? Color.green : Color.red)
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic) { value in
                        AxisGridLine()
                        AxisValueLabel {
                            if let date = value.as(Date.self) {
                                Text(dateFormatter(date))
                                    .font(.caption2)
                            }
                        }
                    }
                }
                .chartYAxis {
                    AxisMarks { value in
                        AxisGridLine()
                        AxisValueLabel {
                            if let num = value.as(Double.self) {
                                Text(String(format: "%.0f%s", num, unit))
                                    .font(.caption2)
                            }
                        }
                    }
                }
                .frame(height: 200)
            } else {
                VStack {
                    Image(systemName: "chart.line")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text("No data available")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 200)
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.05), radius: 8, y: 4)
    }

    // MARK: - Helpers

    private func dateFormatter(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d"
        return formatter.string(from: date)
    }
}

// MARK: - Preview

#Preview {
    let now = Date()
    let dataPoints = (0..<30).map { i -> TrendDataPoint in
        let date = Calendar.current.date(byAdding: .day, value: -i, to: now)!
        let baseValue = 65.0 - Double(i) * 0.1
        return TrendDataPoint(
            date: date,
            value: baseValue + Double.random(in: -2...2),
            isClinicVisit: i == 15,
            annotationLabel: i == 15 ? "Clinic Visit" : nil
        )
    }

    ScrollView {
        VStack(spacing: 20) {
            TrendChartView(
                metricName: "Resting Heart Rate",
                unit: " bpm",
                dataPoints: dataPoints.reversed(),
                isImproving: true,
                timeWindow: .days30
            )

            TrendChartView(
                metricName: "VO2 Max",
                unit: " ml/kg/min",
                dataPoints: (0..<30).map { i -> TrendDataPoint in
                    let date = Calendar.current.date(byAdding: .day, value: -i, to: now)!
                    let baseValue = 42.0 + Double(i) * 0.05
                    return TrendDataPoint(
                        date: date,
                        value: baseValue + Double.random(in: -1...1),
                        isClinicVisit: false,
                        annotationLabel: nil
                    )
                }.reversed(),
                isImproving: true,
                timeWindow: .days30
            )
        }
        .padding()
    }
}
