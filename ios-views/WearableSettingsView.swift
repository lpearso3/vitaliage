import SwiftUI
import SafariServices

// MARK: - Wearable Connections Settings View
// Connect/disconnect Garmin, Oura, and WHOOP via OAuth.

struct IntegrationStatus: Identifiable {
    let id = UUID()
    let key: String
    let name: String
    let authType: String
    let connected: Bool
    let connectedAt: String?

    var icon: String {
        switch key {
        case "garmin": return "applewatch"
        case "oura": return "circle.circle"
        case "whoop": return "waveform.path"
        default: return "link"
        }
    }

    var color: Color {
        switch key {
        case "garmin": return .blue
        case "oura": return .purple
        case "whoop": return .red
        default: return .gray
        }
    }
}

struct WearableSettingsView: View {
    let userId: String
    @State private var integrations: [IntegrationStatus] = []
    @State private var isLoading = true
    @State private var safariURL: URL?
    @State private var showingSafari = false
    @State private var disconnectingProvider: String?

    var body: some View {
        List {
            Section {
                ForEach(integrations) { integration in
                    integrationRow(integration)
                }
            } header: {
                Text("Wearable Devices")
            } footer: {
                Text("Connect your wearable to automatically sync health data like heart rate, sleep, HRV, and activity.")
            }
        }
        .navigationTitle("Connections")
        .task { await loadStatus() }
        .refreshable { await loadStatus() }
        .sheet(isPresented: $showingSafari) {
            if let url = safariURL {
                SafariView(url: url)
                    .ignoresSafeArea()
            }
        }
    }

    // MARK: - Integration Row

    private func integrationRow(_ integration: IntegrationStatus) -> some View {
        HStack(spacing: 14) {
            Image(systemName: integration.icon)
                .font(.title2)
                .foregroundStyle(integration.color)
                .frame(width: 40)

            VStack(alignment: .leading, spacing: 2) {
                Text(integration.name)
                    .font(.headline)

                if integration.connected {
                    Text("Connected")
                        .font(.caption)
                        .foregroundStyle(.green)
                } else {
                    Text("Not connected")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            if integration.connected {
                Button("Disconnect") {
                    Task { await disconnect(integration.key) }
                }
                .font(.caption)
                .foregroundStyle(.red)
                .disabled(disconnectingProvider == integration.key)
            } else {
                Button("Connect") {
                    Task { await startOAuth(integration.key) }
                }
                .buttonStyle(.borderedProminent)
                .tint(integration.color)
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Network

    private func loadStatus() async {
        isLoading = true
        guard let url = URL(string: "\(APIConfig.baseURL)/integrations/status?userId=\(userId)") else { return }
        var request = URLRequest(url: url)
        request.setValue(APIConfig.apiKey, forHTTPHeaderField: "X-Vitaliage-Key")

        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["integrations"] as? [[String: Any]] else {
            isLoading = false
            return
        }

        let decoded = items.compactMap { dict -> IntegrationStatus? in
            guard let key = dict["key"] as? String,
                  let name = dict["name"] as? String else { return nil }
            return IntegrationStatus(
                key: key,
                name: name,
                authType: dict["authType"] as? String ?? "oauth2",
                connected: dict["connected"] as? Bool ?? false,
                connectedAt: dict["connectedAt"] as? String
            )
        }
        await MainActor.run {
            integrations = decoded
            isLoading = false
        }
    }

    private func startOAuth(_ provider: String) async {
        guard let url = URL(string: "\(APIConfig.baseURL)/integrations/\(provider)/auth?userId=\(userId)") else { return }
        var request = URLRequest(url: url)
        request.setValue(APIConfig.apiKey, forHTTPHeaderField: "X-Vitaliage-Key")

        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let authUrlStr = json["authUrl"] as? String,
              let authUrl = URL(string: authUrlStr) else { return }

        await MainActor.run {
            safariURL = authUrl
            showingSafari = true
        }
    }

    private func disconnect(_ provider: String) async {
        await MainActor.run { disconnectingProvider = provider }

        guard let url = URL(string: "\(APIConfig.baseURL)/integrations/\(provider)") else { return }
        let body: [String: Any] = ["userId": userId]
        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(APIConfig.apiKey, forHTTPHeaderField: "X-Vitaliage-Key")
        request.httpBody = jsonData

        _ = try? await URLSession.shared.data(for: request)
        await MainActor.run { disconnectingProvider = nil }
        await loadStatus()
    }
}

// MARK: - Safari View (for OAuth flow)

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}
