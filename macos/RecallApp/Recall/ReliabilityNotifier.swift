import Foundation
import UserNotifications

/// Shows a sustained reliability FAIL from the daemon as a native "Recall"
/// notification, at most once a day. The daemon never posts notifications
/// itself: AppleScript notifications are attributed to Script Editor.
@MainActor
final class ReliabilityNotifier {
    static let shared = ReliabilityNotifier()

    private let lastNotifiedKey = "reliabilityVerdictNotifiedAt"
    private let interval: TimeInterval = 86_400
    private var posting = false

    /// Reads `/health`; notifies only when the daemon asks for it and the
    /// verdict is a sustained FAIL.
    func consider(healthJSON: String, now: Date = Date()) {
        guard !posting, let alert = Self.alert(fromHealth: healthJSON) else { return }
        let last = UserDefaults.standard.double(forKey: lastNotifiedKey)
        guard now.timeIntervalSince1970 - last >= interval else { return }
        posting = true
        Task {
            defer { posting = false }
            let center = UNUserNotificationCenter.current()
            guard (try? await center.requestAuthorization(options: [.alert])) == true else { return }
            let content = UNMutableNotificationContent()
            content.title = "Recall"
            content.body = alert
            let request = UNNotificationRequest(identifier: "recall.reliability", content: content, trigger: nil)
            do {
                try await center.add(request)
                UserDefaults.standard.set(now.timeIntervalSince1970, forKey: lastNotifiedKey)
            } catch {
                // Retry on a later refresh.
            }
        }
    }

    nonisolated static func alert(fromHealth json: String) -> String? {
        guard let data = json.data(using: .utf8),
              let health = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              health["reliability_verdict_notify"] as? Bool == true,
              let verdict = health["reliability_verdict"] as? [String: Any],
              verdict["sustained_fail"] as? Bool == true else { return nil }
        let failing = (verdict["checks"] as? [[String: Any]] ?? [])
            .filter { $0["status"] as? String == "fail" }
            .compactMap { $0["name"] as? String }
        let days = (verdict["consecutive_fail_days"] as? NSNumber)?.intValue ?? 0
        let checks = failing.isEmpty ? "no individual check" : failing.joined(separator: ", ")
        return "Reliability check failing for \(days) days: \(checks). Run `recall doctor` for details."
    }
}
