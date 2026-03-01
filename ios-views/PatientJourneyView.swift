import SwiftUI

// MARK: - Patient Journey Models

struct JourneyMilestone: Identifiable {
    let id = UUID()
    let date: Date
    let title: String
    let description: String
    let type: MilestoneType
    let metrics: [String: String]
    let isCompleted: Bool

    enum MilestoneType: String {
        case clinicVisit = "Clinic Visit"
        case milestone = "Milestone"
        case testResult = "Test Result"
        case event = "Event"

        var icon: String {
            switch self {
            case .clinicVisit: return "stethoscope"
            case .milestone: return "star.fill"
            case .testResult: return "flask.fill"
            case .event: return "calendar"
            }
        }

        var color: Color {
            switch self {
            case .clinicVisit: return .blue
            case .milestone: return .yellow
            case .testResult: return .green
            case .event: return .purple
            }
        }
    }
}

// MARK: - Patient Journey View

struct PatientJourneyView: View {
    let userId: String
    @State private var milestones: [JourneyMilestone] = []
    @State private var isLoading = true
    @State private var selectedMilestone: JourneyMilestone?
    @State private var showDetail = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    // Hero section
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Your Health Journey")
                            .font(.title2.bold())

                        Text("Track your progress and milestones over time")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
                    .background(.ultraThinMaterial)
                    .cornerRadius(16)

                    // Timeline
                    if isLoading {
                        VStack {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                                .padding()
                        }
                    } else if milestones.isEmpty {
                        VStack(spacing: 12) {
                            Image(systemName: "calendar.badge.exclamationmark")
                                .font(.title)
                                .foregroundStyle(.secondary)
                            Text("No milestones yet")
                                .font(.headline)
                            Text("Your health milestones will appear here")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(40)
                    } else {
                        timelineView
                    }
                }
                .padding()
            }
            .navigationTitle("Health Journey")
            .navigationBarTitleDisplayMode(.inline)
            .task { await loadMilestones() }
            .refreshable { await loadMilestones() }
            .sheet(isPresented: $showDetail) {
                if let milestone = selectedMilestone {
                    MilestoneDetailView(milestone: milestone)
                        .presentationDetents([.medium, .large])
                }
            }
        }
    }

    // MARK: - Timeline View

    private var timelineView: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(milestones.indices, id: \.self) { index in
                let milestone = milestones[index]
                let isLast = index == milestones.count - 1

                HStack(alignment: .top, spacing: 16) {
                    // Timeline indicator
                    VStack(spacing: 0) {
                        // Circle
                        Circle()
                            .fill(milestone.type.color)
                            .frame(width: 44, height: 44)
                            .overlay {
                                Image(systemName: milestone.type.icon)
                                    .font(.headline)
                                    .foregroundStyle(.white)
                            }

                        // Connector line
                        if !isLast {
                            VStack(spacing: 0) {
                                Divider()
                                    .frame(height: 2)
                                    .overlay(milestone.type.color.opacity(0.3))
                                    .frame(maxHeight: .infinity)
                            }
                            .frame(height: 120)
                        }
                    }
                    .frame(width: 44)
                    .offset(x: 0, y: 0)

                    // Content
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(milestone.title)
                                    .font(.headline)
                                Text(dateFormatter(milestone.date))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }

                            Spacer()

                            // Type badge
                            Text(milestone.type.rawValue)
                                .font(.caption.bold())
                                .foregroundStyle(.white)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(milestone.type.color)
                                .clipShape(Capsule())
                        }

                        if !milestone.description.isEmpty {
                            Text(milestone.description)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }

                        // Metrics
                        if !milestone.metrics.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(milestone.metrics.sorted(by: { $0.key < $1.key }), id: \.key) { key, value in
                                    HStack {
                                        Text(key)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                        Spacer()
                                        Text(value)
                                            .font(.caption.bold())
                                            .foregroundStyle(.primary)
                                    }
                                }
                            }
                            .padding(8)
                            .background(Color(.systemGray6))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                        }

                        // Detail button
                        Button {
                            selectedMilestone = milestone
                            showDetail = true
                        } label: {
                            HStack {
                                Text("View Details")
                                    .font(.caption.bold())
                                Image(systemName: "arrow.right")
                                    .font(.caption)
                            }
                            .foregroundStyle(milestone.type.color)
                        }
                    }
                    .padding(16)
                    .background(Color(.systemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Spacer(minLength: 0)
                }
                .padding(.bottom, 8)
            }
        }
    }

    // MARK: - Data Loading

    private func loadMilestones() async {
        isLoading = true

        // Sample data - replace with actual API call
        let sampleMilestones = [
            JourneyMilestone(
                date: Date(),
                title: "Biological Age Check",
                description: "Latest assessment shows continued improvement in biological age",
                type: .clinicVisit,
                metrics: [
                    "Biological Age": "45 years",
                    "VO2 Max": "48.5 ml/kg/min",
                    "Confidence": "92%"
                ],
                isCompleted: true
            ),
            JourneyMilestone(
                date: Calendar.current.date(byAdding: .day, value: -14, to: Date())!,
                title: "Achieved Age Defier Badge",
                description: "Your biological age dropped by 3 years since baseline",
                type: .milestone,
                metrics: [
                    "Achievement": "Age Defier",
                    "Delta": "-3 years",
                    "Progress": "100%"
                ],
                isCompleted: true
            ),
            JourneyMilestone(
                date: Calendar.current.date(byAdding: .day, value: -30, to: Date())!,
                title: "Clinic Visit - 6 Month Checkup",
                description: "Comprehensive health assessment and lab work",
                type: .clinicVisit,
                metrics: [
                    "VO2 Max": "48.5 ml/kg/min",
                    "Resting HR": "58 bpm",
                    "Body Fat": "23.5%",
                    "Grip Strength": "52 kg",
                    "6-Min Walk": "580 m"
                ],
                isCompleted: true
            ),
            JourneyMilestone(
                date: Calendar.current.date(byAdding: .day, value: -45, to: Date())!,
                title: "Lab Results Returned",
                description: "Post-intervention lab work shows significant improvements",
                type: .testResult,
                metrics: [
                    "hs-CRP": "0.8 mg/L (was 1.5)",
                    "Lipid Panel": "Improved",
                    "HbA1c": "5.2% (optimal)"
                ],
                isCompleted: true
            ),
            JourneyMilestone(
                date: Calendar.current.date(byAdding: .day, value: -60, to: Date())!,
                title: "Started Personalized Program",
                description: "Began tailored exercise and nutrition protocol",
                type: .event,
                metrics: [
                    "Program": "Advanced Health Optimization",
                    "Duration": "12 weeks",
                    "Focus Areas": "Cardiovascular & Recovery"
                ],
                isCompleted: true
            ),
            JourneyMilestone(
                date: Calendar.current.date(byAdding: .day, value: -90, to: Date())!,
                title: "Initial Clinic Visit",
                description: "Baseline assessment and initial consultations",
                type: .clinicVisit,
                metrics: [
                    "VO2 Max": "42.0 ml/kg/min",
                    "Resting HR": "68 bpm",
                    "Body Fat": "28.2%",
                    "Grip Strength": "48 kg",
                    "6-Min Walk": "520 m",
                    "Age": "52 years"
                ],
                isCompleted: true
            ),
        ]

        await MainActor.run {
            milestones = sampleMilestones
            isLoading = false
        }
    }

    // MARK: - Helpers

    private func dateFormatter(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        return formatter.string(from: date)
    }
}

// MARK: - Milestone Detail View

struct MilestoneDetailView: View {
    let milestone: JourneyMilestone
    @Environment(\.dismiss) var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // Header
                    HStack(spacing: 16) {
                        Image(systemName: milestone.type.icon)
                            .font(.system(size: 32))
                            .foregroundStyle(.white)
                            .frame(width: 60, height: 60)
                            .background(milestone.type.color)
                            .clipShape(Circle())

                        VStack(alignment: .leading, spacing: 4) {
                            Text(milestone.title)
                                .font(.headline)
                            Text(milestone.type.rawValue)
                                .font(.caption)
                                .foregroundStyle(milestone.type.color)
                        }

                        Spacer()
                    }

                    // Date
                    HStack {
                        Image(systemName: "calendar")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(dateFormatterFull(milestone.date))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }

                    Divider()

                    // Description
                    if !milestone.description.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("About This Event")
                                .font(.headline)
                            Text(milestone.description)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }

                    // Metrics
                    if !milestone.metrics.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Key Measurements")
                                .font(.headline)

                            VStack(spacing: 8) {
                                ForEach(milestone.metrics.sorted(by: { $0.key < $1.key }), id: \.key) { key, value in
                                    HStack {
                                        Text(key)
                                            .font(.subheadline)
                                            .foregroundStyle(.secondary)
                                        Spacer()
                                        Text(value)
                                            .font(.subheadline.bold())
                                    }
                                    .padding(12)
                                    .background(Color(.systemGray6))
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                                }
                            }
                        }
                    }

                    // Status
                    HStack {
                        Image(systemName: milestone.isCompleted ? "checkmark.circle.fill" : "clock")
                            .font(.title3)
                            .foregroundStyle(milestone.isCompleted ? .green : .orange)

                        Text(milestone.isCompleted ? "Completed" : "In Progress")
                            .font(.headline)

                        Spacer()
                    }
                    .padding(12)
                    .background(milestone.isCompleted ? Color.green.opacity(0.1) : Color.orange.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                    Spacer()
                }
                .padding()
            }
            .navigationTitle("Event Details")
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

    private func dateFormatterFull(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .full
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }
}

// MARK: - Preview

#Preview {
    PatientJourneyView(userId: "user-123")
}
