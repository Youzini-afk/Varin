import UserNotifications
import WidgetKit

/// Runs on every incoming push that carries `mutable-content: 1` — even when the app is closed
/// — and refreshes the widgets' shared snapshot so the home/lock-screen attention count and
/// unread dot stay current without the app having to foreground. It makes NO network calls:
/// it reads the count the server already put in `aps.badge` and the `threadId` from the push,
/// updates the App Group snapshot the app wrote, and reloads the widget timelines. The app
/// still overwrites the snapshot with the authoritative full list on its next foreground.
class NotificationService: UNNotificationServiceExtension {
    private static let appGroup = "group.dev.varin.mobile"
    private static let snapshotKey = "widgetSnapshot"

    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        self.bestAttempt = request.content.mutableCopy() as? UNMutableNotificationContent

        refreshWidgetSnapshot(from: request)

        // Deliver the notification unchanged (we only used the push to refresh widgets).
        contentHandler(bestAttempt ?? request.content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler = contentHandler {
            handler(bestAttempt ?? UNNotificationContent())
        }
    }

    private func refreshWidgetSnapshot(from request: UNNotificationRequest) {
        guard let defaults = UserDefaults(suiteName: Self.appGroup) else { return }

        var snapshot: [String: Any] = [
            "hostKey": request.content.userInfo["hostKey"] as? String ?? "",
            "attentionCount": 0,
            "recentThreads": [],
        ]
        if let json = defaults.string(forKey: Self.snapshotKey),
           let data = json.data(using: .utf8),
           let stored = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            snapshot = stored
        }

        // A push for another Host must not replace this Host's widget snapshot.
        guard let pushHostKey = request.content.userInfo["hostKey"] as? String,
              !pushHostKey.isEmpty,
              snapshot["hostKey"] as? String == pushHostKey else { return }

        // Attention count: authoritative server value carried in aps.badge.
        if let badge = request.content.badge as? Int {
            snapshot["attentionCount"] = badge
        }

        // Mark the pushed session unread in the existing recent list (best-effort; the full
        // list/titles only refresh when the app next foregrounds).
        if let threadId = request.content.userInfo["threadId"] as? String,
           let branchId = request.content.userInfo["branchId"] as? String,
           var sessions = snapshot["recentThreads"] as? [[String: Any]] {
            for index in sessions.indices where sessions[index]["threadId"] as? String == threadId && sessions[index]["branchId"] as? String == branchId {
                sessions[index]["unread"] = true
            }
            snapshot["recentThreads"] = sessions
        }

        if let data = try? JSONSerialization.data(withJSONObject: snapshot),
           let json = String(data: data, encoding: .utf8) {
            defaults.set(json, forKey: Self.snapshotKey)
        }

        WidgetCenter.shared.reloadAllTimelines()
    }
}
