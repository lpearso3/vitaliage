import SwiftUI
import WatchKit

/// Main Watch app entry point.
/// Initializes HealthKit permissions and WatchConnectivity, then shows dashboard.
@main
struct VitaliageWatchApp: App {
    @StateObject private var healthService = WatchHealthKitService.shared
    @StateObject private var connectivityService = WatchConnectivityService.shared

    @State private var hasRequestedAuthorization = false
    @State private var authorizationError: String?

    var body: some Scene {
        WindowGroup {
            if let error = authorizationError {
                // Show error if authorization failed
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.headline)
                        .foregroundColor(.orange)

                    Text("Permission Required")
                        .font(.headline)

                    Text(error)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding()
            } else {
                // Main dashboard
                WatchDashboardView()
            }
        }
        .task {
            if !hasRequestedAuthorization {
                await requestHealthKitPermissions()
                hasRequestedAuthorization = true
            }
        }
    }

    // MARK: - Authorization

    @MainActor
    private func requestHealthKitPermissions() async {
        do {
            try await healthService.requestAuthorization()
        } catch {
            authorizationError = "Please enable Health data sharing in the Watch app on your iPhone."
            print("HealthKit authorization error: \(error)")
        }
    }
}
