import SwiftUI

// MARK: - Milestone Models

struct MilestoneAchievement: Identifiable, Codable {
    let id: String
    let key: String
    let title: String
    let description: String
    let category: String
    let icon: String
    let requirement: String
    let earnedAt: Date?
    let currentProgress: String?
    let progressPercentage: Double?

    var isEarned: Bool {
        earnedAt != nil
    }

    var color: Color {
        switch category {
        case "fitness": return .orange
        case "recovery": return .indigo
        case "consistency": return .red
        case "clinical": return .green
        default: return .blue
        }
    }
}

// MARK: - Milestones View

struct MilestonesView: View {
    let userId: String
    @State private var achievements: [MilestoneAchievement] = []
    @State private var isLoading = true
    @State private var selectedAchievement: MilestoneAchievement?
    @State private var showDetail = false

    let columns = [
        GridItem(.flexible()),
        GridItem(.flexible()),
        GridItem(.flexible())
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Hero image
                    AppImages.hero(.streaksBadges, height: 180)
                        .cornerRadius(16)
                        .padding(.horizontal)
                        .padding(.top, 8)

                    // Category sections
                    VStack(alignment: .leading, spacing: 24) {
                        ForEach(["fitness", "recovery", "consistency", "clinical"], id: \.self) { category in
                            categorySection(category)
                        }
                    }
                    .padding(.horizontal)
                }
                .padding(.bottom, 40)
            }
            .navigationTitle("Milestones")
            .task { await loadAchievements() }
            .refreshable { await loadAchievements() }
            .sheet(isPresented: $showDetail) {
                if let achievement = selectedAchievement {
                    MilestoneDetailSheet(achievement: achievement)
                        .presentationDetents([.medium, .large])
                }
            }
        }
    }

    // MARK: - Category Section

    private func categorySection(_ category: String) -> some View {
        let categoryAchievements = achievements.filter { $0.category == category }
        let categoryTitle = categoryTitle(for: category)
        let categoryIcon = categoryIcon(for: category)

        return VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label(categoryTitle, systemImage: categoryIcon)
                    .font(.headline.bold())
                    .foregroundStyle(colorForCategory(category))

                Spacer()

                Text("\(categoryAchievements.filter { $0.isEarned }.count)/\(categoryAchievements.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if categoryAchievements.isEmpty {
                HStack {
                    Image(systemName: "questionmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("No milestones in this category")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding()
            } else {
                LazyVGrid(columns: columns, spacing: 16) {
                    ForEach(categoryAchievements) { achievement in
                        milestoneBadge(achievement)
                    }
                }
            }
        }
    }

    // MARK: - Milestone Badge

    private func milestoneBadge(_ achievement: MilestoneAchievement) -> some View {
        Button {
            selectedAchievement = achievement
            showDetail = true
        } label: {
            VStack(spacing: 8) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: achievement.icon)
                        .font(.system(size: 32))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 80)
                        .background(
                            achievement.isEarned
                                ? achievement.color
                                : Color(.systemGray4)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 12))

                    if achievement.isEarned {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.headline)
                            .foregroundStyle(.white, achievement.color)
                            .padding(8)
                    }
                }

                VStack(spacing: 4) {
                    Text(achievement.title)
                        .font(.caption.bold())
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .foregroundStyle(.primary)

                    if !achievement.isEarned, let progress = achievement.progressPercentage {
                        ProgressView(value: progress)
                            .frame(height: 4)
                            .tint(achievement.color)
                    }
                }
            }
        }
    }

    // MARK: - Helpers

    private func categoryTitle(for category: String) -> String {
        switch category {
        case "fitness": return "Fitness"
        case "recovery": return "Recovery"
        case "consistency": return "Consistency"
        case "clinical": return "Clinical"
        default: return category.capitalized
        }
    }

    private func categoryIcon(for category: String) -> String {
        switch category {
        case "fitness": return "bolt.fill"
        case "recovery": return "heart.fill"
        case "consistency": return "flame.fill"
        case "clinical": return "stethoscope"
        default: return "star.fill"
        }
    }

    private func colorForCategory(_ category: String) -> Color {
        switch category {
        case "fitness": return .orange
        case "recovery": return .indigo
        case "consistency": return .red
        case "clinical": return .green
        default: return .blue
        }
    }

    // MARK: - Data Loading

    private func loadAchievements() async {
        isLoading = true

        // Sample data - replace with actual API call
        let sampleAchievements = [
            // Fitness
            MilestoneAchievement(
                id: "vo2-champion",
                key: "vo2_champion",
                title: "VO2 Champion",
                description: "Improved VO2 Max by 10% or more",
                category: "fitness",
                icon: "lungs.fill",
                requirement: "10% improvement",
                earnedAt: Date(timeIntervalSinceNow: -86400 * 5),
                currentProgress: "48.5 ml/kg/min",
                progressPercentage: 1.0
            ),
            MilestoneAchievement(
                id: "step-master",
                key: "step_master",
                title: "Step Master",
                description: "Averaged 10,000+ steps for 30 days",
                category: "fitness",
                icon: "figure.walk",
                requirement: "10k+ steps for 30 days",
                earnedAt: nil,
                currentProgress: "22/30 days",
                progressPercentage: 0.73
            ),
            MilestoneAchievement(
                id: "strength-builder",
                key: "strength_builder",
                title: "Strength Builder",
                description: "Grip strength above age 90th percentile",
                category: "fitness",
                icon: "hand.raised.fill",
                requirement: "90th percentile",
                earnedAt: Date(timeIntervalSinceNow: -86400 * 30),
                currentProgress: "52 kg (95th %ile)",
                progressPercentage: 1.0
            ),

            // Recovery
            MilestoneAchievement(
                id: "sleep-master",
                key: "sleep_master",
                title: "Sleep Master",
                description: "7+ nights meeting sleep goal in a row",
                category: "recovery",
                icon: "moon.stars.fill",
                requirement: "7 consecutive nights",
                earnedAt: Date(timeIntervalSinceNow: -86400 * 10),
                currentProgress: "7/7 nights",
                progressPercentage: 1.0
            ),
            MilestoneAchievement(
                id: "hrv-warrior",
                key: "hrv_warrior",
                title: "HRV Warrior",
                description: "Average HRV improved by 15%",
                category: "recovery",
                icon: "waveform.path.ecg",
                requirement: "15% improvement",
                earnedAt: nil,
                currentProgress: "8% improvement",
                progressPercentage: 0.53
            ),
            MilestoneAchievement(
                id: "heart-health",
                key: "heart_health",
                title: "Heart Health",
                description: "Resting HR below 60 bpm",
                category: "recovery",
                icon: "heart.fill",
                requirement: "< 60 bpm",
                earnedAt: Date(timeIntervalSinceNow: -86400 * 60),
                currentProgress: "58 bpm",
                progressPercentage: 1.0
            ),

            // Consistency
            MilestoneAchievement(
                id: "step-streak",
                key: "step_streak",
                title: "Step Streak",
                description: "30 consecutive days above 8,000 steps",
                category: "consistency",
                icon: "flame.fill",
                requirement: "30 days",
                earnedAt: Date(timeIntervalSinceNow: -86400 * 15),
                currentProgress: "30/30 days",
                progressPercentage: 1.0
            ),
            MilestoneAchievement(
                id: "check-in-warrior",
                key: "check_in_warrior",
                title: "Check-In Warrior",
                description: "Complete 60 consecutive daily check-ins",
                category: "consistency",
                icon: "checkmark.circle.fill",
                requirement: "60 days",
                earnedAt: nil,
                currentProgress: "43/60 days",
                progressPercentage: 0.72
            ),

            // Clinical
            MilestoneAchievement(
                id: "age-defier",
                key: "age_defier",
                title: "Age Defier",
                description: "Biological age dropped 2+ years",
                category: "clinical",
                icon: "sparkles",
                requirement: "2 year drop",
                earnedAt: Date(timeIntervalSinceNow: -86400 * 3),
                currentProgress: "3 years younger",
                progressPercentage: 1.0
            ),
            MilestoneAchievement(
                id: "lab-champion",
                key: "lab_champion",
                title: "Lab Champion",
                description: "3+ biomarkers improved vs baseline",
                category: "clinical",
                icon: "beaker.fill",
                requirement: "3 biomarkers",
                earnedAt: nil,
                currentProgress: "2/3 biomarkers",
                progressPercentage: 0.67
            ),
            MilestoneAchievement(
                id: "walk-strong",
                key: "walk_strong",
                title: "Walk Strong",
                description: "6-minute walk distance > 550m",
                category: "clinical",
                icon: "figure.walk",
                requirement: "> 550m",
                earnedAt: Date(timeIntervalSinceNow: -86400 * 45),
                currentProgress: "580m",
                progressPercentage: 1.0
            ),
        ]

        await MainActor.run {
            achievements = sampleAchievements
            isLoading = false
        }
    }
}

// MARK: - Milestone Detail Sheet

struct MilestoneDetailSheet: View {
    let achievement: MilestoneAchievement
    @Environment(\.dismiss) var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Large icon
                    ZStack {
                        Circle()
                            .fill(achievement.color.opacity(0.15))
                            .frame(width: 120, height: 120)

                        Image(systemName: achievement.icon)
                            .font(.system(size: 56))
                            .foregroundStyle(achievement.color)
                    }

                    // Title and description
                    VStack(spacing: 12) {
                        Text(achievement.title)
                            .font(.title2.bold())

                        Text(achievement.description)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }

                    Divider()

                    // Status
                    VStack(spacing: 16) {
                        if achievement.isEarned, let earnedAt = achievement.earnedAt {
                            HStack {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.headline)
                                    .foregroundStyle(.green)

                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Earned")
                                        .font(.headline)
                                    Text(earnedDate(earnedAt))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }

                                Spacer()
                            }
                            .padding()
                            .background(Color.green.opacity(0.1))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        } else {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("In Progress")
                                    .font(.headline)

                                if let progress = achievement.currentProgress {
                                    HStack {
                                        Text("Current:")
                                            .foregroundStyle(.secondary)
                                        Text(progress)
                                            .fontWeight(.semibold)
                                    }
                                }

                                if let percentage = achievement.progressPercentage {
                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack {
                                            Text("Progress:")
                                                .foregroundStyle(.secondary)
                                            Spacer()
                                            Text(String(format: "%.0f%%", percentage * 100))
                                                .fontWeight(.semibold)
                                        }
                                        ProgressView(value: percentage)
                                            .tint(achievement.color)
                                    }
                                }
                            }
                            .padding()
                            .background(Color(.systemGray6))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                    }

                    // Requirement
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Requirement")
                            .font(.headline)

                        HStack {
                            Image(systemName: "checkmark.square")
                                .font(.title3)
                                .foregroundStyle(achievement.color)

                            Text(achievement.requirement)
                                .foregroundStyle(.secondary)

                            Spacer()
                        }
                        .padding()
                        .background(Color(.systemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }

                    // Tips
                    VStack(alignment: .leading, spacing: 8) {
                        Text("How to Achieve This")
                            .font(.headline)

                        VStack(alignment: .leading, spacing: 8) {
                            tipsForAchievement(achievement)
                        }
                        .padding()
                        .background(Color(.systemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }

                    Spacer()
                }
                .padding()
            }
            .navigationTitle("Milestone")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func tipsForAchievement(_ achievement: MilestoneAchievement) -> some View {
        switch achievement.key {
        case "vo2_champion":
            HStack(spacing: 12) {
                Image(systemName: "checkmark.circle")
                    .foregroundStyle(.green)
                Text("Increase aerobic exercise intensity")
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Image(systemName: "checkmark.circle")
                    .foregroundStyle(.green)
                Text("Aim for 150 min/week of moderate cardio")
                    .foregroundStyle(.secondary)
            }
        case "step_master":
            HStack(spacing: 12) {
                Image(systemName: "checkmark.circle")
                    .foregroundStyle(.green)
                Text("Take daily walks of 30+ minutes")
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Image(systemName: "checkmark.circle")
                    .foregroundStyle(.green)
                Text("Use stairs instead of elevators")
                    .foregroundStyle(.secondary)
            }
        case "sleep_master":
            HStack(spacing: 12) {
                Image(systemName: "checkmark.circle")
                    .foregroundStyle(.green)
                Text("Maintain consistent sleep schedule")
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Image(systemName: "checkmark.circle")
                    .foregroundStyle(.green)
                Text("Avoid screens 30 min before bed")
                    .foregroundStyle(.secondary)
            }
        case "age_defier":
            HStack(spacing: 12) {
                Image(systemName: "checkmark.circle")
                    .foregroundStyle(.green)
                Text("Continue improving across all metrics")
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Image(systemName: "checkmark.circle")
                    .foregroundStyle(.green)
                Text("Focus on recovery and consistency")
                    .foregroundStyle(.secondary)
            }
        default:
            HStack(spacing: 12) {
                Image(systemName: "checkmark.circle")
                    .foregroundStyle(.green)
                Text("Keep improving this metric")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func earnedDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        return "Earned on \(formatter.string(from: date))"
    }
}

// MARK: - Preview

#Preview {
    MilestonesView(userId: "user-123")
}
