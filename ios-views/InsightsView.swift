import SwiftUI

// MARK: - Personalized Insights View
// Displays AI-generated health insights from trend analysis.

struct Insight: Identifiable {
    let id: String
    let title: String
    let body: String
    let insightType: String
    let priority: String
    let metricKey: String?
    let trendDirection: String?
    let dayKey: String

    var icon: String {
        switch insightType {
        case "trend": return "chart.line.uptrend.xyaxis"
        case "alert": return "exclamationmark.triangle.fill"
        case "milestone": return "star.fill"
        case "tip": return "lightbulb.fill"
        default: return "info.circle.fill"
        }
    }

    var color: Color {
        switch priority {
        case "high": return .red
        case "medium": return .orange
        case "low": return .green
        default: return .blue
        }
    }

    var directionIcon: String? {
        switch trendDirection {
        case "improving": return "arrow.up.right"
        case "declining": return "arrow.down.right"
        case "stable": return "arrow.right"
        default: return nil
        }
    }

    var directionColor: Color {
        switch trendDirection {
        case "improving": return .green
        case "declining": return .red
        default: return .gray
        }
    }
}

struct InsightsView: View {
    let userId: String
    @State private var insights: [Insight] = []
    @State private var isLoading = true
    @State private var isGenerating = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // Generate button
                Button {
                    Task { await generateInsights() }
                } label: {
                    HStack {
                        if isGenerating {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "sparkles")
                        }
                        Text(isGenerating ? "Analyzing..." : "Generate New Insights")
                            .fontWeight(.medium)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Color.accentColor)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .disabled(isGenerating)
                .padding(.horizontal)
                .padding(.top, 16)

                if insights.isEmpty && !isLoading {
                    VStack(spacing: 12) {
                        Image(systemName: "chart.bar.xaxis")
                            .font(.system(size: 48))
                            .foregroundStyle(.secondary)
                        Text("No insights yet")
                            .font(.headline)
                        Text("Keep logging your data — insights will appear as patterns emerge.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 60)
                    .padding(.horizontal, 40)
                }

                ForEach(insights) { insight in
                    insightCard(insight)
                }
            }
            .padding(.bottom, 40)
        }
        .navigationTitle("Insights")
        .task { await loadInsights() }
        .refreshable { await loadInsights() }
    }

    // MARK: - Insight Card

    private func insightCard(_ insight: Insight) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: insight.icon)
                    .foregroundStyle(insight.color)
                    .font(.title3)

                Text(insight.title)
                    .font(.headline)

                Spacer()

                if let dirIcon = insight.directionIcon {
                    Image(systemName: dirIcon)
                        .foregroundStyle(insight.directionColor)
                        .font(.caption)
                }

                // Dismiss button
                Button {
                    Task { await dismissInsight(insight.id) }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
            }

            Text(insight.body)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                if let metric = insight.metricKey {
                    Text(metric.replacingOccurrences(of: "_", with: " ").capitalized)
                        .font(.caption2)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(insight.color.opacity(0.15))
                        .clipShape(Capsule())
                }

                Spacer()

                Text(insight.dayKey)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.05), radius: 8, y: 4)
        .padding(.horizontal)
    }

    // MARK: - Network

    private func loadInsights() async {
        isLoading = true
        guard let url = URL(string: "\(APIConfig.baseURL)/insights?userId=\(userId)") else { return }
        var request = URLRequest(url: url)
        request.setValue(APIConfig.apiKey, forHTTPHeaderField: "X-Vitaliage-Key")

        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["insights"] as? [[String: Any]] else {
            isLoading = false
            return
        }

        let decoded = items.compactMap { dict -> Insight? in
            guard let id = dict["id"] as? String,
                  let title = dict["title"] as? String,
                  let body = dict["body"] as? String else { return nil }
            return Insight(
                id: id, title: title, body: body,
                insightType: dict["insight_type"] as? String ?? "tip",
                priority: dict["priority"] as? String ?? "medium",
                metricKey: dict["metric_key"] as? String,
                trendDirection: dict["trend_direction"] as? String,
                dayKey: dict["day_key"] as? String ?? ""
            )
        }
        await MainActor.run {
            insights = decoded
            isLoading = false
        }
    }

    private func generateInsights() async {
        isGenerating = true
        guard let url = URL(string: "\(APIConfig.baseURL)/insights/generate") else {
            isGenerating = false
            return
        }
        let body: [String: Any] = ["userId": userId]
        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else {
            isGenerating = false
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(APIConfig.apiKey, forHTTPHeaderField: "X-Vitaliage-Key")
        request.httpBody = jsonData

        _ = try? await URLSession.shared.data(for: request)
        await MainActor.run { isGenerating = false }
        await loadInsights()
    }

    private func dismissInsight(_ id: String) async {
        guard let url = URL(string: "\(APIConfig.baseURL)/insights/\(id)/dismiss") else { return }
        let body: [String: Any] = ["userId": userId]
        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(APIConfig.apiKey, forHTTPHeaderField: "X-Vitaliage-Key")
        request.httpBody = jsonData

        _ = try? await URLSession.shared.data(for: request)

        await MainActor.run {
            withAnimation { insights.removeAll { $0.id == id } }
        }
    }
}
