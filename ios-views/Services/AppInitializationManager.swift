import Foundation
import Combine

/// AppInitializationManager handles app startup tasks like requesting HealthKit permissions
/// and triggering the initial historical data sync.
class AppInitializationManager: NSObject, ObservableObject {
    static let shared = AppInitializationManager()

    @Published var isInitializing = false
    @Published var initializationError: String?

    private let healthKitService = HealthKitService.shared
    private let backgroundSyncManager = BackgroundSyncManager.shared

    override private init() {
        super.init()
    }

    /// Initialize the app: request HealthKit permissions and perform historical sync if needed.
    func initialize(userId: String) async {
        await MainActor.run {
            isInitializing = true
            initializationError = nil
        }

        defer {
            Task {
                await MainActor.run {
                    isInitializing = false
                }
            }
        }

        do {
            print("[AppInitializationManager] Requesting HealthKit permissions...")
            try await healthKitService.requestAuthorization()

            print("[AppInitializationManager] Starting background historical sync...")
            await backgroundSyncManager.performInitialHistoricalSync(userId: userId)

        } catch {
            let errorMessage = "Initialization failed: \(error.localizedDescription)"
            print("[AppInitializationManager] \(errorMessage)")
            await MainActor.run {
                initializationError = errorMessage
            }
        }
    }
}
