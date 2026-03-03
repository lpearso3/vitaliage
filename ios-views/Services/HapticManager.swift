import UIKit

// MARK: - Haptic Feedback Manager
// Centralized haptic feedback for consistent feel across the app.

enum HapticManager {

      /// Light tap — for rating selections, toggles, small UI interactions
      static func lightTap() {
                let generator = UIImpactFeedbackGenerator(style: .light)
                generator.prepare()
                generator.impactOccurred()
      }

      /// Medium tap — for joining challenges, saving activity entries
      static func mediumTap() {
                let generator = UIImpactFeedbackGenerator(style: .medium)
                generator.prepare()
                generator.impactOccurred()
      }

      /// Success — for completed submissions (check-in saved, etc.)
      static func success() {
                let generator = UINotificationFeedbackGenerator()
                generator.prepare()
                generator.notificationOccurred(.success)
      }

      /// Warning — for interaction alerts, important notices
      static func warning() {
                let generator = UINotificationFeedbackGenerator()
                generator.prepare()
                generator.notificationOccurred(.warning)
      }

      /// Selection tick — ultra-light, for picker/slider changes
      static func selectionTick() {
                let generator = UISelectionFeedbackGenerator()
                generator.prepare()
                generator.selectionChanged()
      }
}
