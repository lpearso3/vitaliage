import SwiftUI

// MARK: - Morning Check-In View
// Submit daily energy, mood, sleep quality, and stress ratings.

struct MorningCheckInView: View {
    @State private var energyLevel: Int = 3
    @State private var mood: Int = 3
    @State private var sleepQuality: Int = 3
    @State private var stressLevel: Int = 3
    @State private var notes: String = ""
    @State private var isSubmitting = false
    @State private var showSuccess = false
    @State private var errorMessage: String?

    let userId: String

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        switch hour {
        case 5..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        default: return "Good evening"
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Header
                VStack(spacing: 8) {
                    Text("\(greeting) ☀️")
                        .font(.largeTitle.bold())
                    Text("How are you feeling today?")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 20)

                // Rating sliders
                ratingRow(title: "Energy", icon: "bolt.fill", color: .orange, value: $energyLevel)
                ratingRow(title: "Mood", icon: "face.smiling.fill", color: .yellow, value: $mood)
                ratingRow(title: "Sleep Quality", icon: "moon.fill", color: .indigo, value: $sleepQuality)
                ratingRow(title: "Stress Level", icon: "waveform.path.ecg", color: .red, value: $stressLevel)

                // Notes
                VStack(alignment: .leading, spacing: 8) {
                    Label("Notes (optional)", systemImage: "note.text")
                        .font(.headline)
                    TextEditor(text: $notes)
                        .frame(minHeight: 80)
                        .padding(8)
                        .background(Color(.systemGray6))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .padding(.horizontal)

                // Submit button
                Button {
                    submitCheckIn()
                } label: {
                    HStack {
                        if isSubmitting {
                            ProgressView()
                                .tint(.white)
                        }
                        Text(isSubmitting ? "Submitting..." : "Submit Check-In")
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.accentColor)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                .disabled(isSubmitting)
                .padding(.horizontal)

                if let errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                        .font(.caption)
                }
            }
            .padding(.bottom, 40)
        }
        .alert("Check-In Saved!", isPresented: $showSuccess) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Great job keeping up with your daily check-in!")
        }
    }

    // MARK: - Rating Row

    private func ratingRow(title: String, icon: String, color: Color, value: Binding<Int>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: icon)
                .font(.headline)
                .foregroundStyle(color)

            HStack(spacing: 12) {
                ForEach(1...5, id: \.self) { level in
                    Button {
                        value.wrappedValue = level
                    } label: {
                        Circle()
                            .fill(level <= value.wrappedValue ? color : Color(.systemGray5))
                            .frame(width: 44, height: 44)
                            .overlay {
                                Text("\(level)")
                                    .font(.callout.bold())
                                    .foregroundStyle(level <= value.wrappedValue ? .white : .secondary)
                            }
                    }
                }
            }
        }
        .padding(.horizontal)
    }

    // MARK: - Submit

    private func submitCheckIn() {
        isSubmitting = true
        errorMessage = nil

        let body: [String: Any] = [
            "userId": userId,
            "energy_level": energyLevel,
            "mood": mood,
            "sleep_quality": sleepQuality,
            "stress_level": stressLevel,
            "notes": notes
        ]

        guard let url = URL(string: "\(APIConfig.baseURL)/check-in"),
              let jsonData = try? JSONSerialization.data(withJSONObject: body) else {
            errorMessage = "Failed to build request"
            isSubmitting = false
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(APIConfig.apiKey, forHTTPHeaderField: "X-Vitaliage-Key")
        request.httpBody = jsonData

        URLSession.shared.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                isSubmitting = false
                if let error {
                    errorMessage = error.localizedDescription
                    return
                }
                showSuccess = true
            }
        }.resume()
    }
}
