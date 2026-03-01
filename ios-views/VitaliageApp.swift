import SwiftUI

/// Main entry point for the Vitaliage iOS application.
@main
struct VitaliageApp: App {
    @StateObject private var initializationManager = AppInitializationManager.shared
    @StateObject private var backgroundSyncManager = BackgroundSyncManager.shared

    // TODO: Replace with your actual user ID retrieval logic
    @State private var userId: String = UUID().uuidString
    @State private var hasInitialized = false

    var body: some Scene {
        WindowGroup {
            if initializationManager.isInitializing {
                // Show progress overlay during initialization
                InitializationProgressView(
                    isInitializing: initializationManager.isInitializing,
                    syncProgress: backgroundSyncManager.historicalSyncProgress
                )
            } else if let error = initializationManager.initializationError {
                // Show error if initialization failed
                InitializationErrorView(error: error) {
                    // Retry initialization
                    Task {
                        await initializationManager.initialize(userId: userId)
                    }
                }
            } else {
                // Show main app once initialized
                MainAppView(userId: userId)
            }
        }
        .task {
            if !hasInitialized {
                await initializationManager.initialize(userId: userId)
                hasInitialized = true
            }
        }
    }
}

// MARK: - Initialization Progress View

struct InitializationProgressView: View {
    let isInitializing: Bool
    let syncProgress: Double

    var body: some View {
        ZStack {
            // Background
            Color(.systemBackground)
                .ignoresSafeArea()

            VStack(spacing: 32) {
                // Hero image or logo
                AppImages.hero(.homeToday, height: 120)
                    .cornerRadius(16)
                    .padding(40)

                VStack(spacing: 16) {
                    Text("Building Your Health Profile")
                        .font(.headline)
                        .foregroundColor(.primary)

                    Text("We're fetching your historical health data to give you the best insights.")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }

                VStack(spacing: 12) {
                    // Progress bar
                    ProgressView(value: syncProgress)
                        .frame(height: 4)
                        .tint(.accentColor)

                    HStack {
                        Text("Syncing data...")
                            .font(.caption)
                            .foregroundColor(.secondary)
                        Spacer()
                        Text("\(Int(syncProgress * 100))%")
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .fontWeight(.semibold)
                    }
                }
                .padding(20)
                .background(Color(.systemGray6))
                .cornerRadius(12)
                .padding()

                Spacer()
            }
            .padding()
        }
    }
}

// MARK: - Initialization Error View

struct InitializationErrorView: View {
    let error: String
    let onRetry: () -> Void

    var body: some View {
        ZStack {
            Color(.systemBackground)
                .ignoresSafeArea()

            VStack(spacing: 24) {
                VStack(spacing: 16) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 48))
                        .foregroundColor(.orange)

                    Text("Setup Issue")
                        .font(.headline)

                    Text(error)
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(24)
                .frame(maxWidth: .infinity)
                .background(Color(.systemGray6))
                .cornerRadius(16)

                Button(action: onRetry) {
                    Text("Try Again")
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.accentColor)
                        .foregroundColor(.white)
                        .cornerRadius(12)
                }

                Spacer()
            }
            .padding()
        }
    }
}

// MARK: - Main App View

/// This is a placeholder for your actual main app view.
/// Replace or integrate with your existing app structure.
struct MainAppView: View {
    let userId: String

    var body: some View {
        TabView {
            HomeTab(viewModel: DeviceDashboardViewModel(userId: userId))
                .tabItem {
                    Label("Home", systemImage: "house.fill")
                }

            InsightsView()
                .tabItem {
                    Label("Insights", systemImage: "sparkles")
                }

            ChallengesView()
                .tabItem {
                    Label("Challenges", systemImage: "target")
                }

            StreaksView()
                .tabItem {
                    Label("Streaks", systemImage: "flame.fill")
                }

            WearableSettingsView(userId: userId)
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
        }
    }
}

// MARK: - DeviceDashboardViewModel Stub

/// This is a placeholder ViewModel. Replace with your actual implementation.
class DeviceDashboardViewModel: ObservableObject {
    let userId: String

    @Published var readinessScore: Double?
    @Published var readinessBand: String?
    @Published var stepsToday: Int?
    @Published var restingHR: Int?
    @Published var hrv: Double?
    @Published var vo2: Double?
    @Published var sleepMinutes: Int?
    @Published var todaySnapshot: DailySnapshot?
    @Published var sleepHistory: [SleepNight] = []
    @Published var resolvedBundle: ResolvedBundle?
    @Published var sleepGoalMinutes: Int = 480

    var averageSleepMinutes: Int? { nil }
    var nightsMeetingGoal: Int { 0 }

    init(userId: String) {
        self.userId = userId
    }

    func refreshAllMetrics() async {
        // TODO: Implement actual data refresh
    }
}

// MARK: - Model Stubs

struct DailySnapshot: Codable {
    let sleep: SleepData?
}

struct SleepData: Codable {
    let totalMinutes: Int?
    let goalMinutes: Int?
    let metGoal: Bool?
}

struct SleepNight: Identifiable {
    let id = UUID()
    let date: Date
    let minutes: Int
}

struct ResolvedBundle: Codable {
    let confidence: ConfidenceData?
    let derivedMetrics: DerivedMetrics?
}

struct ConfidenceData: Codable {
    let overall: OverallConfidence?
}

struct OverallConfidence: Codable {
    let grade: String?
    let score: Double?
}

struct DerivedMetrics: Codable {
    let readiness: ReadinessData?
}

struct ReadinessData: Codable {
    let reasons: [String]?
}
