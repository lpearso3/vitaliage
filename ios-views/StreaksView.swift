import SwiftUI

// MARK: - Streaks & Achievements View
// Displays current streaks and earned achievement badges.

struct StreakInfo: Identifiable, Codable {
    let id: String?
    let streak_type: String
    let current_count: Int
    let longest_count: Int
    let last_activity_date: String?

    var displayName: String {
        switch streak_type {
        case "check_in": return "Check-In"
        case "steps": return "Steps"
        case "sleep": return "Sleep"
        case "hydration": return "Hydration"
        default: return streak_type.capitalized
        }
    }

    var icon: String {
        switch streak_type {
        case "check_in": return "flame.fill"
        case "steps": return "figure.walk"
        case "sleep": return "moon.fill"
        case "hydration": return "drop.fill"
        default: return "star.fill"
        }
    }

    var color: Color {
        switch streak_type {
        case "check_in": return .orange
        case "steps": return .green
        case "sleep": return .indigo
        case "hydration": return .cyan
        default: return .gray
        }
    }
}

struct AchievementInfo: Identifiable, Codable {
    let id: String?
    let achievement_id: String?
    let earned_at: String?
    let achievements: AchievementDefinition?
}

struct AchievementDefinition: Codable {
    let key: String?
    let title: String?
    let description: String?
    let icon_name: String?
    let category: String?
}

struct StreaksView: View {
    let userId: String
    @State private var streaks: [StreakInfo] = []
    @State private var achievements: [AchievementInfo] = []
    @State private var isLoading = true

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Streaks section
                VStack(alignment: .leading, spacing: 16) {
                    Label("Current Streaks", systemImage: "flame.fill")
                        .font(.title2.bold())
                        .foregroundStyle(.orange)
                        .padding(.horizontal)

                    if streaks.isEmpty && !isLoading {
                        Text("Start a streak by doing your daily check-in!")
                            .foregroundStyle(.secondary)
                            .padding(.horizontal)
                    }

                    ForEach(streaks) { streak in
                        streakCard(streak)
                    }
                }
                .padding(.top, 16)

                Divider().padding(.horizontal)

                // Achievements section
                VStack(alignment: .leading, spacing: 16) {
                    Label("Achievements", systemImage: "trophy.fill")
                        .font(.title2.bold())
                        .foregroundStyle(.yellow)
                        .padding(.horizontal)

                    if achievements.isEmpty && !isLoading {
                        Text("Keep going — your first badge is just around the corner!")
                            .foregroundStyle(.secondary)
                            .padding(.horizontal)
                    }

                    LazyVGrid(columns: [
                        GridItem(.flexible()),
                        GridItem(.flexible()),
                        GridItem(.flexible())
                    ], spacing: 16) {
                        ForEach(achievements) { achievement in
                            achievementBadge(achievement)
                        }
                    }
                    .padding(.horizontal)
                }
            }
            .padding(.bottom, 40)
        }
        .navigationTitle("Streaks & Badges")
        .task { await loadData() }
        .refreshable { await loadData() }
    }

    // MARK: - Streak Card

    private func streakCard(_ streak: StreakInfo) -> some View {
        HStack(spacing: 16) {
            Image(systemName: streak.icon)
                .font(.title)
                .foregroundStyle(streak.color)
                .frame(width: 50, height: 50)
                .background(streak.color.opacity(0.15))
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 4) {
                Text(streak.displayName)
                    .font(.headline)
                Text("\(streak.current_count) day streak")
                    .font(.title3.bold())
                    .foregroundStyle(streak.color)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 4) {
                Text("Best")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("\(streak.longest_count)")
                    .font(.title3.bold())
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.05), radius: 8, y: 4)
        .padding(.horizontal)
    }

    // MARK: - Achievement Badge

    private func achievementBadge(_ achievement: AchievementInfo) -> some View {
        VStack(spacing: 8) {
            Image(systemName: achievement.achievements?.icon_name ?? "star.fill")
                .font(.largeTitle)
                .foregroundStyle(.yellow)

            Text(achievement.achievements?.title ?? "Badge")
                .font(.caption.bold())
                .multilineTextAlignment(.center)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity)
        .padding()
        .background(Color(.systemGray6))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Data Loading

    private func loadData() async {
        isLoading = true
        async let streaksTask: () = loadStreaks()
        async let achievementsTask: () = loadAchievements()
        _ = await (streaksTask, achievementsTask)
        isLoading = false
    }

    private func loadStreaks() async {
        guard let url = URL(string: "\(APIConfig.baseURL)/streaks?userId=\(userId)") else { return }
        var request = URLRequest(url: url)
        request.setValue(APIConfig.apiKey, forHTTPHeaderField: "X-Vitaliage-Key")

        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let streaksArray = json["streaks"] as? [[String: Any]] else { return }

        let decoded = streaksArray.compactMap { dict -> StreakInfo? in
            guard let type = dict["streak_type"] as? String else { return nil }
            return StreakInfo(
                id: dict["id"] as? String ?? UUID().uuidString,
                streak_type: type,
                current_count: dict["current_count"] as? Int ?? 0,
                longest_count: dict["longest_count"] as? Int ?? 0,
                last_activity_date: dict["last_activity_date"] as? String
            )
        }
        await MainActor.run { streaks = decoded }
    }

    private func loadAchievements() async {
        guard let url = URL(string: "\(APIConfig.baseURL)/user-achievements?userId=\(userId)") else { return }
        var request = URLRequest(url: url)
        request.setValue(APIConfig.apiKey, forHTTPHeaderField: "X-Vitaliage-Key")

        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["userAchievements"] as? [[String: Any]] else { return }

        // Manual decoding since nested structure
        let decoded: [AchievementInfo] = items.compactMap { dict in
            let achDict = dict["achievements"] as? [String: Any]
            let definition = achDict.map {
                AchievementDefinition(
                    key: $0["key"] as? String,
                    title: $0["title"] as? String,
                    description: $0["description"] as? String,
                    icon_name: $0["icon_name"] as? String,
                    category: $0["category"] as? String
                )
            }
            return AchievementInfo(
                id: dict["id"] as? String ?? UUID().uuidString,
                achievement_id: dict["achievement_id"] as? String,
                earned_at: dict["earned_at"] as? String,
                achievements: definition
            )
        }
        await MainActor.run { achievements = decoded }
    }
}
