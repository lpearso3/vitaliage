import Foundation

// MARK: - Health Metric

/// Represents a single health metric with value, unit, trend, and timestamp.
struct HealthMetric: Codable, Identifiable {
    let id = UUID()
    let value: Double
    let unit: String
    let trend: MetricTrend
    let timestamp: Date
    let displayValue: String

    enum MetricTrend: String, Codable {
        case improving
        case stable
        case declining
    }

    var trendIcon: String {
        switch trend {
        case .improving:
            return "arrow.up.right"
        case .stable:
            return "minus"
        case .declining:
            return "arrow.down.left"
        }
    }

    var trendColor: String {
        switch trend {
        case .improving:
            return "green"
        case .stable:
            return "gray"
        case .declining:
            return "red"
        }
    }
}

// MARK: - Readiness Data

/// Represents the readiness score and related information.
struct ReadinessData: Codable {
    let score: Int // 0-100
    let band: ReadinessBand
    let reasons: [String]
    let confidence: Double? // 0-1
    let lastUpdated: Date

    enum ReadinessBand: String, Codable {
        case excellent
        case good
        case fair
        case poor

        var color: String {
            switch self {
            case .excellent:
                return "green"
            case .good:
                return "cyan"
            case .fair:
                return "yellow"
            case .poor:
                return "red"
            }
        }
    }
}

// MARK: - Daily Snapshot

/// Complete snapshot of a day's health metrics.
struct DailySnapshot: Codable {
    let date: Date
    let steps: Int
    let restingHeartRate: Int?
    let heartRateVariability: Double?
    let sleepMinutes: Int?
    let readiness: ReadinessData?

    var sleepHours: Double? {
        guard let minutes = sleepMinutes else { return nil }
        return Double(minutes) / 60.0
    }
}

// MARK: - Metric History for Charts

/// Historical data for charting trends.
struct MetricHistory: Codable {
    let metricType: MetricType
    let values: [HistoricalValue]
    let averageValue: Double
    let minValue: Double
    let maxValue: Double

    enum MetricType: String, Codable {
        case steps
        case heartRate
        case heartRateVariability
        case sleep
    }

    struct HistoricalValue: Codable, Identifiable {
        let id = UUID()
        let date: Date
        let value: Double
    }
}

// MARK: - Watch Connectivity Data

/// Data synced from iPhone via WatchConnectivity.
struct WatchSyncData: Codable {
    let readiness: ReadinessData?
    let insights: [String]?
    let carePlanItems: [String]?
    let syncTimestamp: Date
}
