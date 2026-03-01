import SwiftUI

/// Central image manager for Vitaliage app images served from the backend.
/// Usage: `AppImages.hero(.onboardingWelcome)` returns an AsyncImage view.
enum AppImageKey: String, CaseIterable {
    case onboardingWelcome = "onboarding-welcome"
    case homeToday = "home-today"
    case sleepTracking = "sleep-tracking"
    case meditationBreathing = "meditation-breathing"
    case learnTab = "learn-tab"
    case morningCheckin = "morning-checkin"
    case streaksBadges = "streaks-badges"
    case weeklyChallenges = "weekly-challenges"
    case personalizedInsights = "personalized-insights"
    case clinicianDashboard = "clinician-dashboard"
    case nutritionWellness = "nutrition-wellness"

    var displayName: String {
        switch self {
        case .onboardingWelcome: return "Welcome"
        case .homeToday: return "Today"
        case .sleepTracking: return "Sleep"
        case .meditationBreathing: return "Meditation"
        case .learnTab: return "Learn"
        case .morningCheckin: return "Check-in"
        case .streaksBadges: return "Streaks"
        case .weeklyChallenges: return "Challenges"
        case .personalizedInsights: return "Insights"
        case .clinicianDashboard: return "Dashboard"
        case .nutritionWellness: return "Nutrition"
        }
    }
}

struct AppImages {
    /// Base URL for image assets (uses APIConfig)
    private static var baseURL: String {
        "\(APIConfig.baseURL)/assets/images"
    }

    /// Returns the URL for a web-optimized image (800px wide)
    static func url(for key: AppImageKey) -> URL? {
        URL(string: "\(baseURL)/\(key.rawValue).jpg")
    }

    /// Returns the URL for an iOS-optimized image at the given scale
    static func iosURL(for key: AppImageKey, scale: Int = 2) -> URL? {
        URL(string: "\(baseURL)/ios/\(key.rawValue)@\(scale)x.jpg")
    }

    /// Returns an AsyncImage view for a hero/banner image
    static func hero(_ key: AppImageKey, height: CGFloat = 200) -> some View {
        AsyncImage(url: iosURL(for: key, scale: 3)) { phase in
            switch phase {
            case .success(let image):
                image
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(height: height)
                    .clipped()
            case .failure:
                Rectangle()
                    .fill(Color.gray.opacity(0.2))
                    .frame(height: height)
                    .overlay(
                        Image(systemName: "photo")
                            .font(.largeTitle)
                            .foregroundColor(.gray)
                    )
            case .empty:
                Rectangle()
                    .fill(Color.gray.opacity(0.1))
                    .frame(height: height)
                    .overlay(ProgressView())
            @unknown default:
                EmptyView()
            }
        }
    }

    /// Returns an AsyncImage view for a card-sized image
    static func card(_ key: AppImageKey, height: CGFloat = 120) -> some View {
        AsyncImage(url: iosURL(for: key, scale: 2)) { phase in
            switch phase {
            case .success(let image):
                image
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(height: height)
                    .clipped()
                    .cornerRadius(12)
            case .failure:
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.gray.opacity(0.2))
                    .frame(height: height)
            case .empty:
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.gray.opacity(0.1))
                    .frame(height: height)
                    .overlay(ProgressView())
            @unknown default:
                EmptyView()
            }
        }
    }
}
