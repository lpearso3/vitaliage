import Foundation

// MARK: - API Configuration
// Central config for the Vitaliage backend.
// Update baseURL to your Render deployment URL for production.

enum APIConfig {
    #if DEBUG
    static let baseURL = "http://localhost:3001"
    #else
    static let baseURL = "https://vitaliage.onrender.com"
    #endif

    // API key for X-Vitaliage-Key header
    // In production, store this in Keychain or a secure config
    static let apiKey = "YOUR_API_KEY_HERE"
}
