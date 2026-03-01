import Foundation
import Combine

/// BackgroundSyncManager orchestrates syncing of wearable data with the backend.
/// Handles both initial historical data sync and ongoing snapshot uploads.
class BackgroundSyncManager: NSObject, ObservableObject {
    static let shared = BackgroundSyncManager()

    @Published var isPerformingHistoricalSync = false
    @Published var historicalSyncProgress: Double = 0.0 // 0.0 to 1.0

    private let healthKitService = HealthKitService.shared
    private let userDefaults = UserDefaults.standard

    private let historicalSyncCompletedKey = "historicalSyncCompleted"

    override private init() {
        super.init()
    }

    // MARK: - Public Methods

    /// Check if historical sync has already been completed.
    var hasCompletedHistoricalSync: Bool {
        userDefaults.bool(forKey: historicalSyncCompletedKey)
    }

    /// Perform the initial historical data sync.
    /// Queries HealthKit for 90 days of historical data and uploads to backend.
    func performInitialHistoricalSync(userId: String) async {
        guard !hasCompletedHistoricalSync else {
            print("[BackgroundSyncManager] Historical sync already completed")
            return
        }

        await MainActor.run {
            isPerformingHistoricalSync = true
            historicalSyncProgress = 0.0
        }

        defer {
            // Mark as completed even if there were errors
            userDefaults.set(true, forKey: historicalSyncCompletedKey)
            Task {
                await MainActor.run {
                    isPerformingHistoricalSync = false
                    historicalSyncProgress = 0.0
                }
            }
        }

        do {
            print("[BackgroundSyncManager] Starting historical sync for 90 days")

            // Query all historical data in parallel
            async let stepsData = healthKitService.fetchHistoricalSteps(days: 90)
            async let hrData = healthKitService.fetchHistoricalHeartRate(days: 90)
            async let hrvData = healthKitService.fetchHistoricalHRV(days: 90)
            async let vo2Data = healthKitService.fetchHistoricalVO2Max(days: 90)
            async let sleepData = healthKitService.fetchHistoricalSleep(days: 90)
            async let respData = healthKitService.fetchHistoricalRespiratoryRate(days: 90)

            let (steps, hr, hrv, vo2, sleep, resp) = try await (stepsData, hrData, hrvData, vo2Data, sleepData, respData)

            // Aggregate data by day and build snapshots
            let snapshots = aggregateDataByDay(
                stepsData: steps,
                hrData: hr,
                hrvData: hrv,
                vo2Data: vo2,
                sleepData: sleep,
                respData: resp,
                userId: userId
            )

            print("[BackgroundSyncManager] Built \(snapshots.count) snapshots, uploading...")

            // Upload snapshots to backend in batches
            let totalSnapshots = snapshots.count
            for (index, snapshot) in snapshots.enumerated() {
                do {
                    try await uploadSnapshot(snapshot)
                    let progress = Double(index + 1) / Double(totalSnapshots)
                    await MainActor.run {
                        historicalSyncProgress = progress
                    }
                } catch {
                    print("[BackgroundSyncManager] Error uploading snapshot: \(error)")
                    // Continue with next snapshot
                }
            }

            print("[BackgroundSyncManager] Historical sync completed")

        } catch {
            print("[BackgroundSyncManager] Error during historical sync: \(error)")
        }
    }

    // MARK: - Private Methods

    /// Aggregate data by day into snapshot payloads.
    private func aggregateDataByDay(
        stepsData: [(date: Date, steps: Int)],
        hrData: [(date: Date, bpm: Double)],
        hrvData: [(date: Date, hrv: Double)],
        vo2Data: [(date: Date, vo2: Double)],
        sleepData: [(date: Date, totalMinutes: Int)],
        respData: [(date: Date, rate: Double)],
        userId: String
    ) -> [[String: Any]] {
        var snapshotsByDay: [Date: [String: Any]] = [:]

        // Helper to add data to snapshot
        func addToSnapshot(date: Date, key: String, value: Any) {
            let dayKey = Calendar.current.startOfDay(for: date)
            if snapshotsByDay[dayKey] == nil {
                snapshotsByDay[dayKey] = ["userId": userId, "date": date.toIsoString()]
            }
            snapshotsByDay[dayKey]![key] = value
        }

        // Populate snapshots
        for (date, steps) in stepsData {
            addToSnapshot(date: date, key: "steps", value: steps)
        }

        for (date, bpm) in hrData {
            addToSnapshot(date: date, key: "restingHR", value: Int(bpm))
        }

        for (date, hrv) in hrvData {
            addToSnapshot(date: date, key: "hrv", value: Int(hrv))
        }

        for (date, vo2) in vo2Data {
            addToSnapshot(date: date, key: "vo2Max", value: vo2)
        }

        for (date, totalMinutes) in sleepData {
            if snapshotsByDay[Calendar.current.startOfDay(for: date)] == nil {
                addToSnapshot(date: date, key: "sleep", value: ["totalMinutes": totalMinutes])
            } else {
                // Update existing sleep data
                let dayKey = Calendar.current.startOfDay(for: date)
                snapshotsByDay[dayKey]?["sleep"] = ["totalMinutes": totalMinutes]
            }
        }

        for (date, rate) in respData {
            addToSnapshot(date: date, key: "respiratoryRate", value: Int(rate))
        }

        // Convert to sorted array
        let sorted = snapshotsByDay
            .sorted { $0.key < $1.key }
            .map { $0.value }

        return sorted
    }

    /// Upload a single snapshot to the backend.
    private func uploadSnapshot(_ snapshot: [String: Any]) async throws {
        guard let url = URL(string: "\(APIConfig.baseURL)/snapshot") else {
            throw NSError(domain: "BackgroundSyncManager", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid URL"])
        }

        let jsonData = try JSONSerialization.data(withJSONObject: snapshot)

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(APIConfig.apiKey, forHTTPHeaderField: "X-Vitaliage-Key")
        request.httpBody = jsonData

        let (_, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw NSError(domain: "BackgroundSyncManager", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])
        }

        guard (200..<300).contains(httpResponse.statusCode) else {
            throw NSError(domain: "BackgroundSyncManager", code: httpResponse.statusCode, userInfo: [NSLocalizedDescriptionKey: "HTTP \(httpResponse.statusCode)"])
        }
    }
}

// MARK: - Helpers

extension Date {
    func toIsoString() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: self)
    }
}

// MARK: - APIConfig Stub

/// APIConfig provides base URL and API key for backend communication.
/// This should be moved to a shared configuration file in your project.
struct APIConfig {
    static let baseURL: String = {
        // Use your actual base URL here
        if let url = Bundle.main.infoDictionary?["API_BASE_URL"] as? String {
            return url
        }
        return "https://api.vitaliage.com"
    }()

    static let apiKey: String = {
        // Use your actual API key here
        if let key = Bundle.main.infoDictionary?["API_KEY"] as? String {
            return key
        }
        return ""
    }()
}
