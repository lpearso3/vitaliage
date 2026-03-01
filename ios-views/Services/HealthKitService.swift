import Foundation
import HealthKit

/// HealthKitService manages all interactions with Apple HealthKit.
/// Handles queries for historical and current health data.
class HealthKitService: NSObject {
    static let shared = HealthKitService()

    private let healthStore = HKHealthStore()

    override private init() {
        super.init()
    }

    // MARK: - Authorization

    /// Request HealthKit permissions for the metrics we need.
    func requestAuthorization() async throws {
        let typesToRead: Set<HKObjectType> = [
            HKObjectType.quantityType(forIdentifier: .stepCount)!,
            HKObjectType.quantityType(forIdentifier: .heartRate)!,
            HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!,
            HKObjectType.quantityType(forIdentifier: .vo2Max)!,
            HKObjectType.quantityType(forIdentifier: .respiratoryRate)!,
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

    // MARK: - Today's Data (Current Implementation)

    /// Fetch today's step count.
    func fetchTodaySteps() async throws -> Int {
        let stepType = HKObjectType.quantityType(forIdentifier: .stepCount)!
        let calendar = Calendar.current
        let startOfDay = calendar.startOfDay(for: Date())
        let now = Date()

        let predicate = HKQuery.predicateForSamples(withStart: startOfDay, end: now, options: [])

        return try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsQuery(quantityType: stepType, quantitySamplePredicate: predicate, options: .cumulativeSum) { _, result, error in
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

    /// Fetch latest resting heart rate sample.
    func fetchLatestRestingHeartRate() async throws -> Int? {
        let hrType = HKObjectType.quantityType(forIdentifier: .heartRate)!
        let sortDescriptor = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)

        let query = HKSampleQuery(
            sampleType: hrType,
            predicate: nil,
            limit: 1,
            sortDescriptors: [sortDescriptor]
        ) { _, samples, _ in }

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

    /// Fetch latest VO2 Max sample.
    func fetchLatestVO2Max() async throws -> Double? {
        let vo2Type = HKObjectType.quantityType(forIdentifier: .vo2Max)!
        let sortDescriptor = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)

        return try await withCheckedThrowingContinuation { continuation in
            healthStore.execute(HKSampleQuery(
                sampleType: vo2Type,
                predicate: nil,
                limit: 1,
                sortDescriptors: [sortDescriptor]
            ) { _, samples, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }

                if let sample = samples?.first as? HKQuantitySample {
                    let vo2 = sample.quantity.doubleValue(for: HKUnit(from: "ml/kg·min"))
                    continuation.resume(returning: vo2)
                } else {
                    continuation.resume(returning: nil)
                }
            })
        }
    }

    /// Fetch last 7 days of sleep.
    func fetchLastSevenDaysSleep() async throws -> [(date: Date, totalMinutes: Int)] {
        let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!
        let calendar = Calendar.current
        let sevenDaysAgo = calendar.date(byAdding: .day, value: -7, to: calendar.startOfDay(for: Date()))!
        let now = Date()

        let predicate = HKQuery.predicateForSamples(withStart: sevenDaysAgo, end: now, options: [])

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

                if let samples = samples as? [HKCategorySample] {
                    for sample in samples {
                        let duration = Int(sample.endDate.timeIntervalSince(sample.startDate) / 60)
                        let dayKey = calendar.startOfDay(for: sample.startDate)
                        sleepByDay[dayKey, default: 0] += duration
                    }
                }

                let result = sleepByDay.sorted { $0.key < $1.key }
                    .map { (date: $0.key, totalMinutes: $0.value) }
                continuation.resume(returning: result)
            })
        }
    }

    // MARK: - Historical Data Methods

    /// Fetch historical daily step totals for the past N days.
    func fetchHistoricalSteps(days: Int) async throws -> [(date: Date, steps: Int)] {
        let stepType = HKObjectType.quantityType(forIdentifier: .stepCount)!
        let calendar = Calendar.current
        let startDate = calendar.date(byAdding: .day, value: -days, to: calendar.startOfDay(for: Date()))!
        let endDate = Date()

        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: [])

        return try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsCollectionQuery(
                quantityType: stepType,
                quantitySamplePredicate: predicate,
                options: .cumulativeSum,
                anchorDate: startDate,
                intervalComponents: DateComponents(day: 1)
            )

            query.initialResultsHandler = { _, statsCollection, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }

                var results: [(date: Date, steps: Int)] = []

                statsCollection?.enumerateStatistics(from: startDate, to: endDate) { stats, _ in
                    let steps = Int(stats.sumQuantity()?.doubleValue(for: HKUnit.count()) ?? 0)
                    results.append((date: stats.startDate, steps: steps))
                }

                continuation.resume(returning: results)
            }

            healthStore.execute(query)
        }
    }

    /// Fetch historical daily average resting heart rate for the past N days.
    func fetchHistoricalHeartRate(days: Int) async throws -> [(date: Date, bpm: Double)] {
        let hrType = HKObjectType.quantityType(forIdentifier: .heartRate)!
        let calendar = Calendar.current
        let startDate = calendar.date(byAdding: .day, value: -days, to: calendar.startOfDay(for: Date()))!
        let endDate = Date()

        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: [])

        return try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsCollectionQuery(
                quantityType: hrType,
                quantitySamplePredicate: predicate,
                options: .discreteAverage,
                anchorDate: startDate,
                intervalComponents: DateComponents(day: 1)
            )

            query.initialResultsHandler = { _, statsCollection, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }

                var results: [(date: Date, bpm: Double)] = []

                statsCollection?.enumerateStatistics(from: startDate, to: endDate) { stats, _ in
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

    /// Fetch historical daily average HRV (SDNN) for the past N days.
    func fetchHistoricalHRV(days: Int) async throws -> [(date: Date, hrv: Double)] {
        let hrvType = HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!
        let calendar = Calendar.current
        let startDate = calendar.date(byAdding: .day, value: -days, to: calendar.startOfDay(for: Date()))!
        let endDate = Date()

        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: [])

        return try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsCollectionQuery(
                quantityType: hrvType,
                quantitySamplePredicate: predicate,
                options: .discreteAverage,
                anchorDate: startDate,
                intervalComponents: DateComponents(day: 1)
            )

            query.initialResultsHandler = { _, statsCollection, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }

                var results: [(date: Date, hrv: Double)] = []

                statsCollection?.enumerateStatistics(from: startDate, to: endDate) { stats, _ in
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

    /// Fetch all VO2 Max samples for the past N days.
    func fetchHistoricalVO2Max(days: Int) async throws -> [(date: Date, vo2: Double)] {
        let vo2Type = HKObjectType.quantityType(forIdentifier: .vo2Max)!
        let calendar = Calendar.current
        let startDate = calendar.date(byAdding: .day, value: -days, to: calendar.startOfDay(for: Date()))!
        let endDate = Date()

        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: [])

        return try await withCheckedThrowingContinuation { continuation in
            healthStore.execute(HKSampleQuery(
                sampleType: vo2Type,
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
            ) { _, samples, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }

                var results: [(date: Date, vo2: Double)] = []

                if let samples = samples as? [HKQuantitySample] {
                    for sample in samples {
                        let vo2 = sample.quantity.doubleValue(for: HKUnit(from: "ml/kg·min"))
                        results.append((date: sample.startDate, vo2: vo2))
                    }
                }

                continuation.resume(returning: results)
            })
        }
    }

    /// Fetch historical daily sleep totals for the past N days.
    func fetchHistoricalSleep(days: Int) async throws -> [(date: Date, totalMinutes: Int)] {
        let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!
        let calendar = Calendar.current
        let startDate = calendar.date(byAdding: .day, value: -days, to: calendar.startOfDay(for: Date()))!
        let endDate = Date()

        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: [])

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

                if let samples = samples as? [HKCategorySample] {
                    for sample in samples {
                        let duration = Int(sample.endDate.timeIntervalSince(sample.startDate) / 60)
                        let dayKey = calendar.startOfDay(for: sample.startDate)
                        sleepByDay[dayKey, default: 0] += duration
                    }
                }

                let result = sleepByDay.sorted { $0.key < $1.key }
                    .map { (date: $0.key, totalMinutes: $0.value) }
                continuation.resume(returning: result)
            })
        }
    }

    /// Fetch historical daily average respiratory rate for the past N days.
    func fetchHistoricalRespiratoryRate(days: Int) async throws -> [(date: Date, rate: Double)] {
        let respType = HKObjectType.quantityType(forIdentifier: .respiratoryRate)!
        let calendar = Calendar.current
        let startDate = calendar.date(byAdding: .day, value: -days, to: calendar.startOfDay(for: Date()))!
        let endDate = Date()

        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: [])

        return try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsCollectionQuery(
                quantityType: respType,
                quantitySamplePredicate: predicate,
                options: .discreteAverage,
                anchorDate: startDate,
                intervalComponents: DateComponents(day: 1)
            )

            query.initialResultsHandler = { _, statsCollection, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }

                var results: [(date: Date, rate: Double)] = []

                statsCollection?.enumerateStatistics(from: startDate, to: endDate) { stats, _ in
                    if let avgQuantity = stats.averageQuantity() {
                        let rate = avgQuantity.doubleValue(for: HKUnit.count().unitDivided(by: HKUnit.minute()))
                        results.append((date: stats.startDate, rate: rate))
                    }
                }

                continuation.resume(returning: results)
            }

            healthStore.execute(query)
        }
    }
}
