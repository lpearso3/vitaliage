import Foundation
import HealthKit

/// Manages HealthKit queries on watchOS.
/// HealthKit is available directly on Apple Watch, so we query it locally.
/// Simplified subset of iOS patterns optimized for Watch constraints.
class WatchHealthKitService: NSObject, ObservableObject {
    static let shared = WatchHealthKitService()

    private let healthStore = HKHealthStore()

    override private init() {
        super.init()
    }

    // MARK: - Authorization

    /// Request HealthKit permissions for Watch.
    func requestAuthorization() async throws {
        let typesToRead: Set<HKObjectType> = [
            HKObjectType.quantityType(forIdentifier: .stepCount)!,
            HKObjectType.quantityType(forIdentifier: .heartRate)!,
            HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!,
            HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!,
        ]

        return try await withCheckedThrowingContinuation { continuation in
            healthStore.requestAuthorization(toShare: [], read: typesToRead) { success, error in
                if let error = error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }

    // MARK: - Today's Data

    /// Fetch today's step count.
    func fetchTodaySteps() async throws -> Int {
        let stepType = HKObjectType.quantityType(forIdentifier: .stepCount)!
        let calendar = Calendar.current
        let startOfDay = calendar.startOfDay(for: Date())
        let now = Date()

        let predicate = HKQuery.predicateForSamples(withStart: startOfDay, end: now, options: [])

        return try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsQuery(
                quantityType: stepType,
                quantitySamplePredicate: predicate,
                options: .cumulativeSum
            ) { _, result, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }

                let steps = Int(result?.sumQuantity()?.doubleValue(for: HKUnit.count()) ?? 0)
                continuation.resume(returning: steps)
            }

            healthStore.execute(query)
        }
    }

    /// Fetch latest resting heart rate.
    func fetchLatestRestingHeartRate() async throws -> Int? {
        let hrType = HKObjectType.quantityType(forIdentifier: .heartRate)!
        let sortDescriptor = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)

        return try await withCheckedThrowingContinuation { continuation in
            healthStore.execute(HKSampleQuery(
                sampleType: hrType,
                predicate: nil,
                limit: 1,
                sortDescriptors: [sortDescriptor]
            ) { _, samples, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }

                if let sample = samples?.first as? HKQuantitySample {
                    let bpm = Int(sample.quantity.doubleValue(for: HKUnit.count().unitDivided(by: HKUnit.minute())))
                    continuation.resume(returning: bpm)
                } else {
                    continuation.resume(returning: nil)
                }
            })
        }
    }

    /// Fetch latest HRV (SDNN) sample.
    func fetchLatestHRV() async throws -> Double? {
        let hrvType = HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!
        let sortDescriptor = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)

        return try await withCheckedThrowingContinuation { continuation in
            healthStore.execute(HKSampleQuery(
                sampleType: hrvType,
                predicate: nil,
                limit: 1,
                sortDescriptors: [sortDescriptor]
            ) { _, samples, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }

                if let sample = samples?.first as? HKQuantitySample {
                    let hrv = sample.quantity.doubleValue(for: HKUnit.millivolt())
                    continuation.resume(returning: hrv)
                } else {
                    continuation.resume(returning: nil)
                }
            })
        }
    }

    /// Fetch last night's sleep duration.
    func fetchLastNightSleep() async throws -> Int? {
        let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!
        let calendar = Calendar.current
        let yesterday = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: Date()))!
        let now = Date()

        let predicate = HKQuery.predicateForSamples(withStart: yesterday, end: now, options: [])

        return try await withCheckedThrowingContinuation { continuation in
            healthStore.execute(HKSampleQuery(
                sampleType: sleepType,
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]
            ) { _, samples, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }

                var totalMinutes = 0
                if let samples = samples as? [HKCategorySample] {
                    for sample in samples {
                        let duration = Int(sample.endDate.timeIntervalSince(sample.startDate) / 60)
                        totalMinutes += duration
                    }
                }

                continuation.resume(returning: totalMinutes > 0 ? totalMinutes : nil)
            })
        }
    }

    // MARK: - Historical Data for Charts

    /// Fetch last 7 days of step counts for trending.
    func fetchSevenDaysSteps() async throws -> [(date: Date, steps: Int)] {
        let stepType = HKObjectType.quantityType(forIdentifier: .stepCount)!
        let calendar = Calendar.current
        let sevenDaysAgo = calendar.date(byAdding: .day, value: -7, to: calendar.startOfDay(for: Date()))!
        let endDate = Date()

        let predicate = HKQuery.predicateForSamples(withStart: sevenDaysAgo, end: endDate, options: [])

        return try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsCollectionQuery(
                quantityType: stepType,
                quantitySamplePredicate: predicate,
                options: .cumulativeSum,
                anchorDate: sevenDaysAgo,
                intervalComponents: DateComponents(day: 1)
            )

            query.initialResultsHandler = { _, statsCollection, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }

                var results: [(date: Date, steps: Int)] = []

                statsCollection?.enumerateStatistics(from: sevenDaysAgo, to: endDate) { stats, _ in
                    let steps = Int(stats.sumQuantity()?.doubleValue(for: HKUnit.count()) ?? 0)
                    results.append((date: stats.startDate, steps: steps))
                }

                continuation.resume(returning: results)
            }

            healthStore.execute(query)
        }
    }

    /// Fetch last 7 days of heart rate for trending.
    func fetchSevenDaysHeartRate() async throws -> [(date: Date, bpm: Double)] {
        let hrType = HKObjectType.quantityType(forIdentifier: .heartRate)!
        let calendar = Calendar.current
        let sevenDaysAgo = calendar.date(byAdding: .day, value: -7, to: calendar.startOfDay(for: Date()))!
        let endDate = Date()

        let predicate = HKQuery.predicateForSamples(withStart: sevenDaysAgo, end: endDate, options: [])

        return try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsCollectionQuery(
                quantityType: hrType,
                quantitySamplePredicate: predicate,
                options: .discreteAverage,
                anchorDate: sevenDaysAgo,
                intervalComponents: DateComponents(day: 1)
            )

            query.initialResultsHandler = { _, statsCollection, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }

                var results: [(date: Date, bpm: Double)] = []

                statsCollection?.enumerateStatistics(from: sevenDaysAgo, to: endDate) { stats, _ in
                    if let avgQuantity = stats.averageQuantity() {
                        let bpm = avgQuantity.doubleValue(for: HKUnit.count().unitDivided(by: HKUnit.minute()))
                        results.append((date: stats.startDate, bpm: bpm))
                    }
                }

                continuation.resume(returning: results)
            }

            healthStore.execute(query)
        }
    }

    /// Fetch last 7 days of HRV for trending.
    func fetchSevenDaysHRV() async throws -> [(date: Date, hrv: Double)] {
        let hrvType = HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!
        let calendar = Calendar.current
        let sevenDaysAgo = calendar.date(byAdding: .day, value: -7, to: calendar.startOfDay(for: Date()))!
        let endDate = Date()

        let predicate = HKQuery.predicateForSamples(withStart: sevenDaysAgo, end: endDate, options: [])

        return try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsCollectionQuery(
                quantityType: hrvType,
                quantitySamplePredicate: predicate,
                options: .discreteAverage,
                anchorDate: sevenDaysAgo,
                intervalComponents: DateComponents(day: 1)
            )

            query.initialResultsHandler = { _, statsCollection, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }

                var results: [(date: Date, hrv: Double)] = []

                statsCollection?.enumerateStatistics(from: sevenDaysAgo, to: endDate) { stats, _ in
                    if let avgQuantity = stats.averageQuantity() {
                        let hrv = avgQuantity.doubleValue(for: HKUnit.millivolt())
                        results.append((date: stats.startDate, hrv: hrv))
                    }
                }

                continuation.resume(returning: results)
            }

            healthStore.execute(query)
        }
    }

    /// Fetch last 7 days of sleep for trending.
    func fetchSevenDaysSleep() async throws -> [(date: Date, minutes: Int)] {
        let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!
        let calendar = Calendar.current
        let sevenDaysAgo = calendar.date(byAdding: .day, value: -7, to: calendar.startOfDay(for: Date()))!
        let endDate = Date()

        let predicate = HKQuery.predicateForSamples(withStart: sevenDaysAgo, end: endDate, options: [])

        return try await withCheckedThrowingContinuation { continuation in
            healthStore.execute(HKSampleQuery(
                sampleType: sleepType,
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
            ) { _, samples, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }

                var sleepByDay: [Date: Int] = [:]
                let calendar = Calendar.current

                if let samples = samples as? [HKCategorySample] {
                    for sample in samples {
                        let duration = Int(sample.endDate.timeIntervalSince(sample.startDate) / 60)
                        let dayKey = calendar.startOfDay(for: sample.startDate)
                        sleepByDay[dayKey, default: 0] += duration
                    }
                }

                let result = sleepByDay.sorted { $0.key < $1.key }
                    .map { (date: $0.key, minutes: $0.value) }
                continuation.resume(returning: result)
            })
        }
    }
}
