import UserNotifications
import Foundation

/**
 ReadinessNotificationHandler

 Handles morning readiness push notifications from the backend.
 - Processes notification taps and routes to appropriate screen
 - Extracts readiness score and state from notification payload
 - Deep links to HomeTab with readiness detail

 Usage:
 1. In AppDelegate or SceneDelegate, call didReceiveRemoteNotification with the notification payload
 2. Or, configure UNUserNotificationCenter delegate and call handleNotificationResponse

 Notification payload structure:
 {
   "aps": {
     "alert": {
       "title": "Ready for Today",
       "body": "Your readiness score is 85! Great day for Running."
     },
     "sound": "default"
   },
   "data": {
     "type": "readiness",
     "readinessScore": "85",
     "state": "ready"
   }
 }
 */
class ReadinessNotificationHandler: NSObject, UNUserNotificationCenterDelegate {

  // MARK: - Singleton
  static let shared = ReadinessNotificationHandler()

  // MARK: - Properties
  var onReadinessNotificationReceived: ((ReadinessNotificationData) -> Void)?

  // MARK: - Notification Payload Structure
  struct ReadinessNotificationData {
    let readinessScore: Int
    let state: String // "ready", "easy", "rest"
    let type: String // "readiness"
    let title: String
    let body: String
  }

  // MARK: - UNUserNotificationCenter Delegate

  /// Called when a notification arrives while app is in foreground
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let userInfo = notification.request.content.userInfo

    if let data = parseReadinessNotification(userInfo) {
      // App is in foreground; show the notification
      // Call our delegate so views can react
      DispatchQueue.main.async {
        self.onReadinessNotificationReceived?(data)
      }

      // Show notification banner + sound
      completionHandler([.banner, .sound])
    } else {
      // Not a readiness notification
      completionHandler([])
    }
  }

  /// Called when user taps on the notification
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo

    if let data = parseReadinessNotification(userInfo) {
      // User tapped the notification - handle navigation
      DispatchQueue.main.async {
        self.navigateToReadinessDetail(data: data)
        self.onReadinessNotificationReceived?(data)
      }
    }

    completionHandler()
  }

  // MARK: - Parse Notification Payload

  /// Parse incoming notification to extract readiness data
  private func parseReadinessNotification(_ userInfo: [AnyHashable: Any]) -> ReadinessNotificationData? {
    // Check if this is a readiness notification
    guard let dataDict = userInfo as? [String: Any],
          let type = dataDict["type"] as? String,
          type == "readiness" else {
      return nil
    }

    guard let scoreStr = dataDict["readinessScore"] as? String,
          let score = Int(scoreStr),
          let state = dataDict["state"] as? String else {
      // Fallback values if parsing fails
      return ReadinessNotificationData(
        readinessScore: 50,
        state: "easy",
        type: "readiness",
        title: "Readiness Check",
        body: "Check your readiness score"
      )
    }

    // Extract alert title and body from APS
    var title = "Readiness Check"
    var body = "Check your readiness score"

    if let aps = userInfo["aps"] as? [String: Any],
       let alert = aps["alert"] as? [String: String] {
      title = alert["title"] ?? title
      body = alert["body"] ?? body
    }

    return ReadinessNotificationData(
      readinessScore: score,
      state: state,
      type: "readiness",
      title: title,
      body: body
    )
  }

  // MARK: - Navigation

  /// Navigate to readiness detail view in HomeTab
  private func navigateToReadinessDetail(data: ReadinessNotificationData) {
    // This function would be called from the app's root coordinator/router
    // For Ionic/Capacitor apps, you might need to post a notification

    // Method 1: Using NotificationCenter (if app uses it)
    NotificationCenter.default.post(
      name: NSNotification.Name("ReadinessNotificationTapped"),
      object: nil,
      userInfo: [
        "score": data.readinessScore,
        "state": data.state
      ]
    )

    // Method 2: Using a global app coordinator (pseudocode)
    // AppCoordinator.shared.navigateToHomeTabWithReadiness(score: data.readinessScore)

    // Method 3: For Ionic/Capacitor, emit a Capacitor notification
    // NotificationCenter.default.post(name: NSNotification.Name("capacitor://readiness-detail"))
  }

  // MARK: - Notification Registration

  /// Register for remote notifications and set up notification center delegate
  func setupNotificationHandling() {
    // Set notification center delegate
    UNUserNotificationCenter.current().delegate = self

    // Request user permission
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
      if granted {
        DispatchQueue.main.async {
          UIApplication.shared.registerForRemoteNotifications()
        }
        print("✓ Notification permission granted")
      } else if let error = error {
        print("✗ Notification permission error:", error.localizedDescription)
      }
    }
  }

  // MARK: - Handle Remote Notification (from AppDelegate)

  /// Call this from AppDelegate's didFinishLaunchingWithOptions or application(_:didReceiveRemoteNotification:)
  func handleRemoteNotification(userInfo: [AnyHashable: Any]) {
    if let data = parseReadinessNotification(userInfo) {
      DispatchQueue.main.async {
        self.onReadinessNotificationReceived?(data)
      }
    }
  }

  // MARK: - Test Method

  /// Send a test readiness notification (for debugging)
  func sendTestNotification() {
    let content = UNMutableNotificationContent()
    content.title = "Test Readiness"
    content.body = "Your readiness score is 75! Consider a lighter workout today."
    content.sound = .default
    content.badge = NSNumber(value: UIApplication.shared.applicationIconBadgeNumber + 1)

    // Add custom data
    content.userInfo = [
      "type": "readiness",
      "readinessScore": "75",
      "state": "easy"
    ]

    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
    let request = UNNotificationRequest(identifier: "test-readiness", content: content, trigger: trigger)

    UNUserNotificationCenter.current().add(request) { error in
      if let error = error {
        print("✗ Failed to schedule test notification:", error.localizedDescription)
      } else {
        print("✓ Test notification scheduled for 5 seconds from now")
      }
    }
  }
}

// MARK: - NotificationContentExtension (Rich Notifications)

/**
 ReadinessNotificationViewController

 This extends UNNotificationContentExtension to display a rich notification
 with the readiness score circle and custom UI.

 Usage:
 1. Create a NotificationContent target in Xcode
 2. Add this as the NotificationViewController.swift
 3. Update the notification extension's Info.plist:
    - UNNotificationExtensionCategory: "readiness"
    - UNNotificationExtensionInitialContentSizeRatio: 0.5 (or desired height ratio)
    - UNNotificationExtensionDefaultContentHidden: false (or true if you want only custom UI)

 The notification payload would include:
 {
   "aps": {
     "mutable-content": 1,
     "category": "readiness"
   },
   ...
 }
 */

#if canImport(UIKit)
import UIKit

class ReadinessNotificationViewController: UIViewController, UNNotificationContentExtension {

  @IBOutlet weak var scoreCircleView: UIView?
  @IBOutlet weak var scoreLabel: UILabel?
  @IBOutlet weak var stateLabel: UILabel?
  @IBOutlet weak var messageLabel: UILabel?

  override func viewDidLoad() {
    super.viewDidLoad()
    setupUI()
  }

  func didReceive(_ notification: UNNotification) {
    let userInfo = notification.request.content.userInfo

    // Parse readiness data
    if let scoreStr = userInfo["readinessScore"] as? String,
       let score = Int(scoreStr),
       let state = userInfo["state"] as? String {
      updateUI(score: score, state: state)
    }
  }

  private func setupUI() {
    // Initialize score circle
    if let circleView = scoreCircleView {
      circleView.layer.cornerRadius = circleView.frame.size.width / 2
      circleView.clipsToBounds = true
      circleView.layer.borderWidth = 3
    }
  }

  private func updateUI(score: Int, state: String) {
    // Update score circle color based on state
    let color = colorForState(state)
    scoreCircleView?.backgroundColor = color
    scoreCircleView?.layer.borderColor = color.cgColor

    // Update labels
    scoreLabel?.text = "\(score)"
    scoreLabel?.font = UIFont.systemFont(ofSize: 32, weight: .bold)
    scoreLabel?.textColor = .white

    stateLabel?.text = stateDisplayName(state)
    stateLabel?.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
    stateLabel?.textColor = color

    // Add message based on state
    let message: String
    switch state {
    case "ready":
      message = "Great day for activity!"
    case "rest":
      message = "Focus on recovery"
    default:
      message = "Take it easy"
    }
    messageLabel?.text = message
    messageLabel?.font = UIFont.systemFont(ofSize: 14, weight: .regular)
  }

  private func colorForState(_ state: String) -> UIColor {
    switch state {
    case "ready":
      return UIColor(red: 0.2, green: 0.8, blue: 0.2, alpha: 1) // Green
    case "rest":
      return UIColor(red: 1.0, green: 0.3, blue: 0.3, alpha: 1) // Red
    default:
      return UIColor(red: 1.0, green: 0.8, blue: 0.2, alpha: 1) // Yellow
    }
  }

  private func stateDisplayName(_ state: String) -> String {
    switch state {
    case "ready":
      return "Ready"
    case "rest":
      return "Rest Day"
    default:
      return "Easy Day"
    }
  }
}

#endif
