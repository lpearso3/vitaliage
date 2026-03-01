import SwiftUI

// MARK: - Share Progress Models

struct ProgressSnapshot {
    let biologicalAge: Int
    let chronologicalAge: Int
    let vo2Max: Double?
    let vo2MaxChange: String?
    let bodyFat: Double?
    let bodyFatChange: String?
    let restingHR: Int?
    let restingHRChange: String?
    let gripStrength: Double?
    let gripStrengthChange: String?
    let sleepHours: Double?
    let sleepChange: String?
    let walkDistance: Double?
    let walkDistanceChange: String?
    let periodDays: Int
    let timestamp: Date
}

// MARK: - Share Progress View

struct ShareProgressView: View {
    let snapshot: ProgressSnapshot
    @State private var showShareSheet = false
    @State private var selectedMetrics: Set<String> = [
        "biologicalAge", "vo2Max", "bodyFat", "restingHR", "gripStrength", "sleep", "walkDistance"
    ]
    @State private var previewImage: UIImage?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Preview card
                    sharePreviewCard
                        .onAppear {
                            generatePreviewImage()
                        }

                    Divider()

                    // Privacy toggles
                    VStack(alignment: .leading, spacing: 16) {
                        Text("What to share")
                            .font(.headline)

                        VStack(spacing: 12) {
                            metricToggle("Biological Age", key: "biologicalAge")
                            metricToggle("VO2 Max", key: "vo2Max")
                            metricToggle("Body Fat %", key: "bodyFat")
                            metricToggle("Resting Heart Rate", key: "restingHR")
                            metricToggle("Grip Strength", key: "gripStrength")
                            metricToggle("Sleep", key: "sleep")
                            metricToggle("6-Min Walk", key: "walkDistance")
                        }
                    }
                    .padding()
                    .background(Color(.systemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 16))

                    // Share button
                    Button {
                        showShareSheet = true
                    } label: {
                        HStack {
                            Image(systemName: "square.and.arrow.up")
                            Text("Share Progress")
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.accentColor)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .padding()

                    // Info
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Image(systemName: "info.circle")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text("Share as image")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Share Your Progress")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showShareSheet) {
                if let image = previewImage {
                    ActivityViewController(activityItems: [image])
                }
            }
        }
    }

    // MARK: - Share Preview Card

    private var sharePreviewCard: some View {
        VStack(spacing: 20) {
            // Header
            VStack(spacing: 8) {
                Text("My Progress")
                    .font(.title2.bold())

                Text("Last \(snapshot.periodDays) days")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Biological age (always show)
            VStack(spacing: 8) {
                HStack {
                    Text("Biological Age")
                        .foregroundStyle(.secondary)
                    Spacer()
                    HStack(spacing: 4) {
                        Text("\(snapshot.biologicalAge)")
                            .font(.headline)
                        Text("vs \(snapshot.chronologicalAge)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(12)
                .background(Color.blue.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            // Selected metrics
            VStack(spacing: 8) {
                if selectedMetrics.contains("vo2Max"), let vo2 = snapshot.vo2Max {
                    HStack {
                        Text("VO2 Max")
                            .foregroundStyle(.secondary)
                        Spacer()
                        HStack(spacing: 4) {
                            Text(String(format: "%.1f", vo2))
                                .font(.headline)
                            if let change = snapshot.vo2MaxChange {
                                Text(change)
                                    .font(.caption)
                                    .foregroundStyle(.green)
                            }
                        }
                    }
                    .padding(12)
                    .background(Color.orange.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                if selectedMetrics.contains("bodyFat"), let bf = snapshot.bodyFat {
                    HStack {
                        Text("Body Fat")
                            .foregroundStyle(.secondary)
                        Spacer()
                        HStack(spacing: 4) {
                            Text(String(format: "%.1f%%", bf))
                                .font(.headline)
                            if let change = snapshot.bodyFatChange {
                                Text(change)
                                    .font(.caption)
                                    .foregroundStyle(.green)
                            }
                        }
                    }
                    .padding(12)
                    .background(Color.pink.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                if selectedMetrics.contains("restingHR"), let hr = snapshot.restingHR {
                    HStack {
                        Text("Resting HR")
                            .foregroundStyle(.secondary)
                        Spacer()
                        HStack(spacing: 4) {
                            Text("\(hr)")
                                .font(.headline)
                            if let change = snapshot.restingHRChange {
                                Text(change)
                                    .font(.caption)
                                    .foregroundStyle(.green)
                            }
                        }
                    }
                    .padding(12)
                    .background(Color.red.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                if selectedMetrics.contains("gripStrength"), let grip = snapshot.gripStrength {
                    HStack {
                        Text("Grip Strength")
                            .foregroundStyle(.secondary)
                        Spacer()
                        HStack(spacing: 4) {
                            Text(String(format: "%.1f", grip))
                                .font(.headline)
                            if let change = snapshot.gripStrengthChange {
                                Text(change)
                                    .font(.caption)
                                    .foregroundStyle(.green)
                            }
                        }
                    }
                    .padding(12)
                    .background(Color.yellow.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                if selectedMetrics.contains("sleep"), let sleep = snapshot.sleepHours {
                    HStack {
                        Text("Sleep")
                            .foregroundStyle(.secondary)
                        Spacer()
                        HStack(spacing: 4) {
                            Text(String(format: "%.1f h", sleep))
                                .font(.headline)
                            if let change = snapshot.sleepChange {
                                Text(change)
                                    .font(.caption)
                                    .foregroundStyle(.green)
                            }
                        }
                    }
                    .padding(12)
                    .background(Color.indigo.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                if selectedMetrics.contains("walkDistance"), let walk = snapshot.walkDistance {
                    HStack {
                        Text("6-Min Walk")
                            .foregroundStyle(.secondary)
                        Spacer()
                        HStack(spacing: 4) {
                            Text(String(format: "%.0f m", walk))
                                .font(.headline)
                            if let change = snapshot.walkDistanceChange {
                                Text(change)
                                    .font(.caption)
                                    .foregroundStyle(.green)
                            }
                        }
                    }
                    .padding(12)
                    .background(Color.cyan.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }

            // Footer
            VStack(spacing: 6) {
                Text("Vitaliage")
                    .font(.caption.bold())
                Text("Track. Improve. Age Better.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
        }
        .padding(20)
        .background(
            LinearGradient(
                gradient: Gradient(colors: [
                    Color(.systemBackground),
                    Color(.systemGray6)
                ]),
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .shadow(color: .black.opacity(0.1), radius: 8, y: 4)
    }

    // MARK: - Metric Toggle

    private func metricToggle(_ label: String, key: String) -> some View {
        Toggle(isOn: Binding(
            get: { selectedMetrics.contains(key) },
            set: { newValue in
                if newValue {
                    selectedMetrics.insert(key)
                } else {
                    selectedMetrics.remove(key)
                }
                generatePreviewImage()
            }
        )) {
            Text(label)
        }
    }

    // MARK: - Preview Image Generation

    private func generatePreviewImage() {
        // Create a snapshot of the preview card
        let renderer = ImageRenderer(content: sharePreviewCard)
        renderer.scale = 3.0
        if let image = renderer.uiImage {
            previewImage = image
        }
    }
}

// MARK: - Activity View Controller Wrapper

struct ActivityViewController: UIViewControllerRepresentable {
    let activityItems: [Any]
    @Environment(\.dismiss) var dismiss

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in
            dismiss()
        }
        return controller
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// MARK: - Preview

#Preview {
    ShareProgressView(
        snapshot: ProgressSnapshot(
            biologicalAge: 45,
            chronologicalAge: 52,
            vo2Max: 48.5,
            vo2MaxChange: "+6.5%",
            bodyFat: 23.5,
            bodyFatChange: "-2.1%",
            restingHR: 58,
            restingHRChange: "-5 bpm",
            gripStrength: 52,
            gripStrengthChange: "+3 kg",
            sleepHours: 7.3,
            sleepChange: "+0.4 h",
            walkDistance: 580,
            walkDistanceChange: "+35m",
            periodDays: 90,
            timestamp: Date()
        )
    )
}
