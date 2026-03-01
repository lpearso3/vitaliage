import Foundation
import WatchConnectivity

/// Manages communication between Watch and iPhone via WatchConnectivity.
/// Receives readiness scores, insights, and care plan data from iPhone.
/// Falls back to local HealthKit if iPhone is not reachable.
class WatchConnectivityService: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = WatchConnectivityService()

    @Published var readinessData: ReadinessData?
    @Published var insights: [String] = []
    @Published var carePlanItems: [String] = []
    @Published var isConnectedToPhone = false
    @Published var lastSyncTime: Date?

    private var wcSession: WCSession?

    override private init() {
        super.init()
        setupWatchConnectivity()
    }

    // MARK: - Setup

    private func setupWatchConnectivity() {
        if WCSession.isSupported() {
            wcSession = WCSession.default
            wcSession?.delegate = self
            wcSession?.activate()
        }
    }

    // MARK: - WCSessionDelegate

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        DispatchQueue.main.async {
            self.isConnectedToPhone = activationState == .activated
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {
        DispatchQueue.main.async {
            self.isConnectedToPhone = false
        }
    }

    func sessionDidDeactivate(_ session: WCSession) {
        DispatchQueue.main.async {
            self.isConnectedToPhone = false
        }
    }

    /// Receive data from iPhone.
    func session(
        _ session: WCSession,
        didReceiveApplicationContext applicationContext: [String: Any]
    ) {
        DispatchQueue.main.async {
            self.processApplicationContext(applicationContext)
        }
    }

    /// Receive data via file transfer from iPhone.
    func session(
        _ session: WCSession,
        didReceive file: WCSessionFile
    ) {
        // Handle large file transfers if needed
        DispatchQueue.main.async {
            self.processFile(file)
        }
    }

    // MARK: - Data Processing

    private func processApplicationContext(_ context: [String: Any]) {
        if let readinessDict = context["readiness"] as? [String: Any] {
            if let data = try? JSONSerialization.data(withJSONObject: readinessDict),
               let readiness = try? JSONDecoder().decode(ReadinessData.self, from: data) {
                self.readinessData = readiness
            }
        }

        if let insights = context["insights"] as? [String] {
            self.insights = insights
        }

        if let carePlan = context["carePlan"] as? [String] {
            self.carePlanItems = carePlan
        }

        self.lastSyncTime = Date()
    }

    private func processFile(_ file: WCSessionFile) {
        // For future use: handle large data transfers
        try? FileManager.default.removeItem(at: file.fileURL)
    }

    // MARK: - Sending Data to iPhone

    /// Send current watch metrics to iPhone for aggregation.
    func sendWatchMetricsToPhone(snapshot: DailySnapshot) {
        guard let wcSession = wcSession, wcSession.isReachable else {
            return
        }

        do {
            let data = try JSONEncoder().encode(snapshot)
            if let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                wcSession.sendMessage(
                    ["watchSnapshot": dict],
                    replyHandler: nil,
                    errorHandler: { error in
                        print("Error sending watch metrics: \(error)")
                    }
                )
            }
        } catch {
            print("Error encoding snapshot: \(error)")
        }
    }

    // MARK: - Request Data from iPhone

    /// Request latest readiness data from iPhone.
    func requestReadinessFromPhone(completion: @escaping (ReadinessData?) -> Void) {
        guard let wcSession = wcSession, wcSession.isReachable else {
            completion(nil)
            return
        }

        wcSession.sendMessage(
            ["requestReadiness": true],
            replyHandler: { reply in
                if let readinessDict = reply["readiness"] as? [String: Any] {
                    do {
                        let data = try JSONSerialization.data(withJSONObject: readinessDict)
                        let readiness = try JSONDecoder().decode(ReadinessData.self, from: data)
                        DispatchQueue.main.async {
                            self.readinessData = readiness
                            completion(readiness)
                        }
                    } catch {
                        completion(nil)
                    }
                } else {
                    completion(nil)
                }
            },
            errorHandler: { error in
                print("Error requesting readiness: \(error)")
                completion(nil)
            }
        )
    }

    // MARK: - Connectivity Status

    func isPhoneReachable() -> Bool {
        wcSession?.isReachable ?? false
    }
}
