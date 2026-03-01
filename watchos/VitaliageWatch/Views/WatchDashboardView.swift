import SwiftUI

/// Main Watch dashboard showing readiness score and key metrics.
struct WatchDashboardView: View {
    @ObservedObject var healthService = WatchHealthKitService.shared
    @ObservedObject var connectivityService = WatchConnectivityService.shared

    @State private var todaySnapshot: DailySnapshot?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    // Readiness gauge at top
                    readinessGauge

                    // Key metrics grid
                    metricsGrid

                    // Sync status
                    syncStatusView
                }
                .padding(.vertical, 8)
                .padding(.horizontal, 4)
            }
            .navigationTitle("Vitaliage")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable {
                await refreshData()
            }
            .onAppear {
                Task {
                    await refreshData()
                }
            }
        }
    }

    // MARK: - Readiness Gauge

    private var readinessGauge: some View {
        Group {
            if let readiness = connectivityService.readinessData {
                ZStack {
                    // Background circle
                    Circle()
                        .stroke(Color(.systemGray4), lineWidth: 6)
                        .frame(height: 100)

                    // Progress circle
                    Circle()
                        .trim(from: 0, to: CGFloat(readiness.score) / 100.0)
                        .stroke(
                            readinessColor(readiness.band),
                            style: StrokeStyle(lineWidth: 6, lineCap: .round)
                        )
                        .frame(height: 100)
                        .rotationEffect(.degrees(-90))
                        .animation(.easeOut(duration: 0.5), value: readiness.score)

                    // Score text
                    VStack(spacing: 0) {
                        Text("\(readiness.score)")
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                        Text("/ 100")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 120)

                // Band label
                Text(bandLabel(readiness.band))
                    .font(.caption)
                    .foregroundColor(readinessColor(readiness.band))
                    .frame(maxWidth: .infinity, alignment: .center)
            } else {
                // Placeholder
                ZStack {
                    Circle()
                        .stroke(Color(.systemGray4), lineWidth: 6)
                        .frame(height: 100)

                    ProgressView()
                        .tint(.accentColor)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 120)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 12)
    }

    // MARK: - Metrics Grid

    private var metricsGrid: some View {
        Group {
            // Steps
            NavigationLink(destination: MetricDetailView(
                metricType: .steps,
                currentValue: todaySnapshot?.steps ?? 0,
                displayUnit: "steps"
            )) {
                metricTile(
                    icon: "figure.walk",
                    title: "Steps",
                    value: formatSteps(todaySnapshot?.steps ?? 0),
                    color: .blue
                )
            }

            // Resting HR
            if let hr = todaySnapshot?.restingHeartRate {
                NavigationLink(destination: MetricDetailView(
                    metricType: .heartRate,
                    currentValue: Double(hr),
                    displayUnit: "bpm"
                )) {
                    metricTile(
                        icon: "heart.fill",
                        title: "Resting HR",
                        value: "\(hr)",
                        color: .red
                    )
                }
            }

            // HRV
            if let hrv = todaySnapshot?.heartRateVariability {
                NavigationLink(destination: MetricDetailView(
                    metricType: .hrv,
                    currentValue: hrv,
                    displayUnit: "ms"
                )) {
                    metricTile(
                        icon: "waveform.path.ecg",
                        title: "HRV",
                        value: "\(Int(hrv))",
                        color: .purple
                    )
                }
            }

            // Sleep
            if let sleep = todaySnapshot?.sleepHours {
                NavigationLink(destination: MetricDetailView(
                    metricType: .sleep,
                    currentValue: sleep,
                    displayUnit: "hours"
                )) {
                    metricTile(
                        icon: "bed.double.fill",
                        title: "Sleep",
                        value: String(format: "%.1f h", sleep),
                        color: .green
                    )
                }
            }
        }
    }

    // MARK: - Metric Tile

    private func metricTile(
        icon: String,
        title: String,
        value: String,
        color: Color
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.caption)
                    .foregroundColor(color)
                Text(title)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            Text(value)
                .font(.system(.headline, design: .rounded))
                .foregroundColor(.primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Color(.systemGray6))
        .cornerRadius(8)
        .contentShape(Rectangle())
    }

    // MARK: - Sync Status

    private var syncStatusView: some View {
        VStack(spacing: 6) {
            HStack(spacing: 4) {
                Image(systemName: connectivityService.isConnectedToPhone ? "iphone.radiowaves.left.and.right" : "iphone.slash")
                    .font(.caption2)
                    .foregroundColor(connectivityService.isConnectedToPhone ? .green : .orange)

                Text(connectivityService.isConnectedToPhone ? "Connected" : "Offline Mode")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            if let lastSync = connectivityService.lastSyncTime {
                Text("Last sync: \(formatSyncTime(lastSync))")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            if let error = errorMessage {
                Text(error)
                    .font(.caption2)
                    .foregroundColor(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(8)
        .background(Color(.systemGray6))
        .cornerRadius(8)
        .padding(.horizontal, 12)
    }

    // MARK: - Data Loading

    @MainActor
    private func refreshData() async {
        isLoading = true
        defer { isLoading = false }

        do {
            // Fetch HealthKit data
            let steps = try await healthService.fetchTodaySteps()
            let hr = try await healthService.fetchLatestRestingHeartRate()
            let hrv = try await healthService.fetchLatestHRV()
            let sleep = try await healthService.fetchLastNightSleep()

            // Update snapshot
            let snapshot = DailySnapshot(
                date: Date(),
                steps: steps,
                restingHeartRate: hr,
                heartRateVariability: hrv,
                sleepMinutes: sleep,
                readiness: nil
            )

            todaySnapshot = snapshot
            errorMessage = nil

            // Request readiness from iPhone
            connectivityService.requestReadinessFromPhone { _ in }
        } catch {
            errorMessage = "Failed to load metrics"
            print("Error refreshing data: \(error)")
        }
    }

    // MARK: - Helpers

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

    private func bandLabel(_ band: ReadinessData.ReadinessBand) -> String {
        switch band {
        case .excellent:
            return "Excellent"
        case .good:
            return "Good"
        case .fair:
            return "Fair"
        case .poor:
            return "Poor"
        }
    }

    private func formatSteps(_ steps: Int) -> String {
        if steps >= 1000 {
            return String(format: "%.1fk", Double(steps) / 1000)
        }
        return "\(steps)"
    }

    private func formatSyncTime(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            let formatter = DateFormatter()
            formatter.timeStyle = .short
            return formatter.string(from: date)
        } else if calendar.isDateInYesterday(date) {
            return "Yesterday"
        } else {
            let formatter = DateFormatter()
            formatter.dateStyle = .short
            return formatter.string(from: date)
        }
    }
}

// MARK: - Preview

#Preview {
    WatchDashboardView()
}
