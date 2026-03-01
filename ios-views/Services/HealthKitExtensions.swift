import Foundation
import HealthKit

// MARK: - HKUnit Extensions

extension HKUnit {
    /// Returns the unit for VO2 Max (ml/kg·min)
    static var vo2MaxUnit: HKUnit {
        HKUnit(from: "ml/kg·min")
    }
}

// MARK: - Date Helpers

extension Date {
    /// Returns the day key in UTC format (YYYY-MM-DD) for database deduplication.
    var dayKeyUTC: String {
        let calendar = Calendar(identifier: .iso8601)
        let components = calendar.dateComponents([.year, .month, .day], from: self)
        return String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }

    /// Returns the start of day in UTC.
    var startOfDayUTC: Date {
        let calendar = Calendar(identifier: .iso8601)
        var components = calendar.dateComponents([.year, .month, .day], from: self)
        components.timeZone = TimeZone(abbreviation: "UTC")
        return calendar.date(from: components) ?? self
    }
}

// MARK: - HealthKit Sample Filtering

extension Array where Element == HKSample {
    /// Filters samples by date range.
    func filterByDateRange(start: Date, end: Date) -> [HKSample] {
        filter { sample in
            sample.startDate >= start && sample.startDate <= end
        }
    }
}

extension Array where Element == HKQuantitySample {
    /// Computes average quantity value.
    func averageQuantity(for unit: HKUnit) -> HKQuantity? {
        guard !isEmpty else { return nil }
        let sum = reduce(0.0) { $0 + $1.quantity.doubleValue(for: unit) }
        let average = sum / Double(count)
        return HKQuantity(unit: unit, doubleValue: average)
    }

    /// Computes total/sum quantity value.
    func totalQuantity(for unit: HKUnit) -> HKQuantity? {
        guard !isEmpty else { return nil }
        let sum = reduce(0.0) { $0 + $1.quantity.doubleValue(for: unit) }
        return HKQuantity(unit: unit, doubleValue: sum)
    }
}

extension Array where Element == HKCategorySample {
    /// Filters sleep samples and sums duration.
    func sleepDurationInMinutes() -> Int {
        let minutes = reduce(0) { total, sample in
            Int(sample.endDate.timeIntervalSince(sample.startDate) / 60) + total
        }
        return minutes
    }
}

// MARK: - Snapshot Payload Builder

/// Helper for building snapshot payloads to send to backend.
struct SnapshotPayloadBuilder {
    var userId: String
    var date: Date
    var steps: Int?
    var restingHR: Int?
    var hrv: Int?
    var vo2Max: Double?
    var respiratoryRate: Int?
    var sleep: SleepSnapshot?

    struct SleepSnapshot {
        var totalMinutes: Int
        var goalMinutes: Int?
        var metGoal: Bool?
    }

    /// Build the JSON payload for POST /snapshot.
    func build() -> [String: Any] {
        var payload: [String: Any] = [
            "userId": userId,
            "date": date.toIsoString()
        ]

        if let steps = steps {
            payload["steps"] = steps
        }
        if let restingHR = restingHR {
            payload["restingHR"] = restingHR
        }
        if let hrv = hrv {
            payload["hrv"] = hrv
        }
        if let vo2Max = vo2Max {
            payload["vo2Max"] = vo2Max
        }
        if let respiratoryRate = respiratoryRate {
            payload["respiratoryRate"] = respiratoryRate
        }
        if let sleep = sleep {
            var sleepPayload: [String: Any] = ["totalMinutes": sleep.totalMinutes]
            if let goalMinutes = sleep.goalMinutes {
                sleepPayload["goalMinutes"] = goalMinutes
            }
            if let metGoal = sleep.metGoal {
                sleepPayload["metGoal"] = metGoal
            }
            payload["sleep"] = sleepPayload
        }

        return payload
    }
}

// MARK: - Sync State Persistence

/// Helper for persisting sync state to UserDefaults.
class SyncStateManager {
    private let defaults = UserDefaults.standard
    private let keyPrefix = "vitaliage.sync"

    func markHistoricalSyncCompleted() {
        defaults.set(true, forKey: "\(keyPrefix).historicalCompleted")
        defaults.set(Date().timeIntervalSince1970, forKey: "\(keyPrefix).lastHistoricalSync")
    }

    func isHistoricalSyncCompleted() -> Bool {
        defaults.bool(forKey: "\(keyPrefix).historicalCompleted")
    }

    func lastHistoricalSyncDate() -> Date? {
        let timestamp = defaults.double(forKey: "\(keyPrefix).lastHistoricalSync")
        guard timestamp > 0 else { return nil }
        return Date(timeIntervalSince1970: timestamp)
    }

    func markDailySnaphotUploaded(for date: Date) {
        let key = "\(keyPrefix).uploaded.\(date.dayKeyUTC)"
        defaults.set(true, forKey: key)
    }

    func isDailySnapshotUploaded(for date: Date) -> Bool {
        let key = "\(keyPrefix).uploaded.\(date.dayKeyUTC)"
        return defaults.bool(forKey: key)
    }

    func clearAllSyncState() {
        let keys = defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix(keyPrefix) }
        keys.forEach { defaults.removeObject(forKey: $0) }
    }
}

// MARK: - Network Error Handling

struct NetworkError: LocalizedError {
    let statusCode: Int
    let message: String

    var errorDescription: String? {
        "Network error \(statusCode): \(message)"
    }
}

// MARK: - Logging Helper

class SyncLogger {
    enum Level: String {
        case debug = "DEBUG"
        case info = "INFO"
        case warning = "WARN"
        case error = "ERROR"
    }

    private let serviceName: String

    init(_ serviceName: String) {
        self.serviceName = serviceName
    }

    func log(_ level: Level = .info, _ message: String) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        print("[\(timestamp)] [\(serviceName)] [\(level.rawValue)] \(message)")
    }

    func debug(_ message: String) {
        log(.debug, message)
    }

    func info(_ message: String) {
        log(.info, message)
    }

    func warning(_ message: String) {
        log(.warning, message)
    }

    func error(_ message: String) {
        log(.error, message)
    }
}
