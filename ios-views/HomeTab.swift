import SwiftUI
import Charts

/// Home tab — the primary dashboard with readiness score, metrics, and sleep.
/// This is the native replacement for GoodBarber's "Home Dashboard" tab.
struct HomeTab: View {
    @ObservedObject var viewModel: DeviceDashboardViewModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    // Hero image
                    AppImages.hero(.homeToday, height: 200)
                        .cornerRadius(16)

                    readinessCard
                    metricsGrid
                    sleepCard
                }
                .padding()
            }
            .navigationTitle("Vitaliage")
            .refreshable {
                viewModel.refreshAllMetrics()
            }
        }
    }

    // MARK: - Readiness Card

    private var readinessCard: some View {
        VStack(spacing: 12) {
            ZStack {
                Circle()
                    .stroke(Color(.systemGray4), lineWidth: 10)
                    .frame(width: 120, height: 120)

                Circle()
                    .trim(from: 0, to: readinessProgress)
                    .stroke(
                        readinessColor,
                        style: StrokeStyle(lineWidth: 10, lineCap: .round)
                    )
                    .frame(width: 120, height: 120)
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.6), value: readinessProgress)

                VStack(spacing: 2) {
                    if let score = viewModel.readinessScore {
                        Text("\(Int(score))")
                            .font(.system(size: 36, weight: .bold, design: .rounded))
                        Text("/ 100")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    } else {
                        Image(systemName: "ellipsis")
                            .font(.title2)
                            .foregroundColor(.secondary)
                    }
                }
            }

            if let state = viewModel.readinessBand {
                Text(readinessLabel(for: state))
                    .font(.headline)
                    .foregroundColor(readinessColor)
            } else {
                Text("Calculating Readiness")
                    .font(.headline)
                    .foregroundColor(.secondary)
            }

            // Confidence badge
            if let bundle = viewModel.resolvedBundle,
               let confidence = bundle.confidence?.overall {
                HStack(spacing: 4) {
                    Image(systemName: "shield.checkered")
                        .font(.caption2)
                    if let grade = confidence.grade {
                        Text("Confidence: \(grade.uppercased())")
                    }
                    if let score = confidence.score {
                        Text("(\(Int(score * 100))%)")
                    }
                }
                .font(.caption)
                .foregroundColor(.secondary)
            }

            // Reasons
            if let reasons = viewModel.resolvedBundle?.derivedMetrics?.readiness?.reasons,
               !reasons.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(reasons, id: \.self) { reason in
                        HStack(alignment: .top, spacing: 6) {
                            Image(systemName: "info.circle")
                                .font(.caption2)
                                .foregroundColor(.secondary)
                                .padding(.top, 2)
                            Text(reason)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity)
        .background(.ultraThinMaterial)
        .cornerRadius(20)
    }

    // MARK: - Metrics Grid

    private var metricsGrid: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                MetricCard(
                    icon: "figure.walk",
                    title: "Steps",
                    value: viewModel.stepsToday.map { "\(formatNumber($0))" } ?? "—",
                    color: .blue
                )
                MetricCard(
                    icon: "waveform.path.ecg",
                    title: "HRV",
                    value: viewModel.hrv.map { "\(Int($0)) ms" } ?? "—",
                    color: .purple
                )
            }

            HStack(spacing: 12) {
                MetricCard(
                    icon: "heart.fill",
                    title: "Resting HR",
                    value: viewModel.restingHR.map { "\($0) bpm" } ?? "—",
                    color: .red
                )
                MetricCard(
                    icon: "lungs.fill",
                    title: "VO\u{2082} Max",
                    value: viewModel.vo2.map { String(format: "%.1f", $0) } ?? "—",
                    color: .orange
                )
            }

            if let sleep = viewModel.todaySnapshot?.sleep,
               let total = sleep.totalMinutes {
                let metGoal = sleep.metGoal ?? false
                MetricCard(
                    icon: "bed.double.fill",
                    title: "Sleep (last night)",
                    value: formatMinutes(total),
                    color: metGoal ? .green : .red
                )
            } else if let mins = viewModel.sleepMinutes {
                MetricCard(
                    icon: "bed.double.fill",
                    title: "Sleep (last night)",
                    value: formatMinutes(mins),
                    color: mins >= viewModel.sleepGoalMinutes ? .green : .red
                )
            }
        }
    }

    // MARK: - Sleep Card

    private var sleepCard: some View {
        Group {
            if !viewModel.sleepHistory.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Sleep This Week")
                        .font(.headline)

                    if let avg = viewModel.averageSleepMinutes {
                        Text("Avg: \(formatMinutes(avg))  •  \(viewModel.nightsMeetingGoal)/\(viewModel.sleepHistory.count) nights on goal")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }

                    // Simple bar chart
                    Chart(viewModel.sleepHistory.suffix(7)) { night in
                        BarMark(
                            x: .value("Date", night.date, unit: .day),
                            y: .value("Minutes", night.minutes)
                        )
                        .foregroundStyle(night.minutes >= viewModel.sleepGoalMinutes ? Color.green : Color.red)
                        .cornerRadius(4)
                    }
                    .chartYAxis {
                        AxisMarks(values: .automatic) { value in
                            AxisGridLine()
                            AxisValueLabel {
                                if let mins = value.as(Int.self) {
                                    Text(formatMinutes(mins))
                                        .font(.caption2)
                                }
                            }
                        }
                    }
                    .frame(height: 160)
                }
                .padding()
                .background(.ultraThinMaterial)
                .cornerRadius(16)
            }
        }
    }

    // MARK: - Helpers

    private var readinessProgress: CGFloat {
        guard let score = viewModel.readinessScore else { return 0 }
        return CGFloat(max(0, min(score, 100))) / 100
    }

    private var readinessColor: Color {
        ReadinessHelpers.color(band: viewModel.readinessBand, score: viewModel.readinessScore)
    }

    private func readinessLabel(for state: String) -> String {
        ReadinessHelpers.label(forBand: state)
    }

    private func formatNumber(_ n: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: n)) ?? "\(n)"
    }

    private func formatMinutes(_ m: Int) -> String {
        let h = m / 60
        let mins = m % 60
        if h > 0 && mins > 0 { return "\(h)h \(mins)m" }
        if h > 0 { return "\(h)h" }
        return "\(mins)m"
    }
}
