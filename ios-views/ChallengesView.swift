import SwiftUI

// MARK: - Weekly Challenges View
// Browse active challenges, join them, and track progress.

struct Challenge: Identifiable {
    let id: String
    let title: String
    let description: String
    let category: String
    let targetValue: Double
    let durationDays: Int
    let startDate: String
    let endDate: String

    var icon: String {
        switch category {
        case "steps": return "figure.walk"
        case "sleep": return "moon.fill"
        case "hydration": return "drop.fill"
        case "mindfulness": return "brain.head.profile"
        case "nutrition": return "leaf.fill"
        default: return "trophy.fill"
        }
    }

    var color: Color {
        switch category {
        case "steps": return .green
        case "sleep": return .indigo
        case "hydration": return .cyan
        case "mindfulness": return .purple
        case "nutrition": return .mint
        default: return .orange
        }
    }
}

struct UserChallenge: Identifiable {
    let id: String
    let challengeId: String
    let challenge: Challenge?
    let currentProgress: Double
    let completed: Bool
    let joinedAt: String
}

struct ChallengesView: View {
    let userId: String
    @State private var activeChallenges: [Challenge] = []
    @State private var userChallenges: [UserChallenge] = []
    @State private var joinedIds: Set<String> = []
    @State private var isLoading = true

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Hero image
                AppImages.hero(.weeklyChallenges, height: 180)
                    .cornerRadius(16)
                    .padding(.horizontal)
                    .padding(.top, 8)

                // My active challenges
                if !myActiveChallenges.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("My Challenges", systemImage: "flag.fill")
                            .font(.title2.bold())
                            .padding(.horizontal)

                        ForEach(myActiveChallenges) { uc in
                            userChallengeCard(uc)
                        }
                    }
                    .padding(.top, 16)

                    Divider().padding(.horizontal)
                }

                // Available challenges
                VStack(alignment: .leading, spacing: 12) {
                    Label("Available Challenges", systemImage: "sparkles")
                        .font(.title2.bold())
                        .padding(.horizontal)

                    if availableChallenges.isEmpty && !isLoading {
                        Text("No new challenges available right now. Check back soon!")
                            .foregroundStyle(.secondary)
                            .padding(.horizontal)
                    }

                    ForEach(availableChallenges) { challenge in
                        challengeCard(challenge)
                    }
                }
                .padding(.top, myActiveChallenges.isEmpty ? 16 : 0)
            }
            .padding(.bottom, 40)
        }
        .navigationTitle("Challenges")
        .task { await loadData() }
        .refreshable { await loadData() }
    }

    private var myActiveChallenges: [UserChallenge] {
        userChallenges.filter { !$0.completed }
    }

    private var availableChallenges: [Challenge] {
        activeChallenges.filter { !joinedIds.contains($0.id) }
    }

    // MARK: - User Challenge Card (with progress)

    private func userChallengeCard(_ uc: UserChallenge) -> some View {
        let challenge = uc.challenge
        let progress = challenge.map { min(uc.currentProgress / $0.targetValue, 1.0) } ?? 0

        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: challenge?.icon ?? "trophy.fill")
                    .font(.title2)
                    .foregroundStyle(challenge?.color ?? .orange)

                VStack(alignment: .leading) {
                    Text(challenge?.title ?? "Challenge")
                        .font(.headline)
                    Text(challenge?.description ?? "")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if uc.completed {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .font(.title2)
                }
            }

            ProgressView(value: progress)
                .tint(challenge?.color ?? .orange)

            Text("\(Int(uc.currentProgress)) / \(Int(challenge?.targetValue ?? 0))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.05), radius: 8, y: 4)
        .padding(.horizontal)
    }

    // MARK: - Available Challenge Card

    private func challengeCard(_ challenge: Challenge) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: challenge.icon)
                    .font(.title2)
                    .foregroundStyle(challenge.color)
                    .frame(width: 44, height: 44)
                    .background(challenge.color.opacity(0.15))
                    .clipShape(Circle())

                VStack(alignment: .leading) {
                    Text(challenge.title)
                        .font(.headline)
                    Text(challenge.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()
            }

            HStack {
                Label("\(challenge.durationDays) days", systemImage: "calendar")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Spacer()

                Button("Join") {
                    Task { await joinChallenge(challenge.id) }
                }
                .buttonStyle(.borderedProminent)
                .tint(challenge.color)
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.05), radius: 8, y: 4)
        .padding(.horizontal)
    }

    // MARK: - Network

    private func loadData() async {
        isLoading = true
        async let c: () = loadChallenges()
        async let u: () = loadUserChallenges()
        _ = await (c, u)
        isLoading = false
    }

    private func loadChallenges() async {
        guard let url = URL(string: "\(APIConfig.baseURL)/challenges") else { return }
        var request = URLRequest(url: url)
        request.setValue(APIConfig.apiKey, forHTTPHeaderField: "X-Vitaliage-Key")

        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["challenges"] as? [[String: Any]] else { return }

        let decoded = items.compactMap { dict -> Challenge? in
            guard let id = dict["id"] as? String,
                  let title = dict["title"] as? String else { return nil }
            return Challenge(
                id: id, title: title,
                description: dict["description"] as? String ?? "",
                category: dict["category"] as? String ?? "",
                targetValue: (dict["target_value"] as? NSNumber)?.doubleValue ?? 0,
                durationDays: dict["duration_days"] as? Int ?? 7,
                startDate: dict["start_date"] as? String ?? "",
                endDate: dict["end_date"] as? String ?? ""
            )
        }
        await MainActor.run { activeChallenges = decoded }
    }

    private func loadUserChallenges() async {
        guard let url = URL(string: "\(APIConfig.baseURL)/user-challenges?userId=\(userId)") else { return }
        var request = URLRequest(url: url)
        request.setValue(APIConfig.apiKey, forHTTPHeaderField: "X-Vitaliage-Key")

        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["userChallenges"] as? [[String: Any]] else { return }

        let decoded = items.compactMap { dict -> UserChallenge? in
            guard let id = dict["id"] as? String else { return nil }
            let challengeDict = dict["challenges"] as? [String: Any]
            let challenge = challengeDict.flatMap { cd -> Challenge? in
                guard let cid = cd["id"] as? String, let title = cd["title"] as? String else { return nil }
                return Challenge(
                    id: cid, title: title,
                    description: cd["description"] as? String ?? "",
                    category: cd["category"] as? String ?? "",
                    targetValue: (cd["target_value"] as? NSNumber)?.doubleValue ?? 0,
                    durationDays: cd["duration_days"] as? Int ?? 7,
                    startDate: cd["start_date"] as? String ?? "",
                    endDate: cd["end_date"] as? String ?? ""
                )
            }
            return UserChallenge(
                id: id,
                challengeId: dict["challenge_id"] as? String ?? "",
                challenge: challenge,
                currentProgress: (dict["current_progress"] as? NSNumber)?.doubleValue ?? 0,
                completed: dict["completed"] as? Bool ?? false,
                joinedAt: dict["joined_at"] as? String ?? ""
            )
        }
        await MainActor.run {
            userChallenges = decoded
            joinedIds = Set(decoded.map(\.challengeId))
        }
    }

    private func joinChallenge(_ challengeId: String) async {
        guard let url = URL(string: "\(APIConfig.baseURL)/challenges/join") else { return }
        let body: [String: Any] = ["userId": userId, "challengeId": challengeId]
        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(APIConfig.apiKey, forHTTPHeaderField: "X-Vitaliage-Key")
        request.httpBody = jsonData

        _ = try? await URLSession.shared.data(for: request)
        await loadData()
    }
}
