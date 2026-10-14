import SwiftUI
import WidgetKit

// MARK: - Shared model + App Group reader

/// One row of the session overview the app writes to the shared App Group.
/// Mirrors MobileWidgetThread in packages/ui/src/apps/mobileWidgetSnapshot.ts.
struct WidgetThread: Codable, Identifiable, Hashable {
    let threadId: String
    let branchId: String
    let url: String
    var id: String { threadId + ":" + branchId }
    let title: String
    let unread: Bool
    /// Project label for the session's directory. Optional so snapshots written before this
    /// field existed still decode.

}

/// The session overview snapshot. Mirrors MobileWidgetSnapshot (same field names) so the
/// JSON the app stores decodes directly.
struct WidgetSnapshot: Codable {
    var hostKey: String?
    let attentionCount: Int
    let recentThreads: [WidgetThread]

    static let empty = WidgetSnapshot(hostKey: nil, attentionCount: 0, recentThreads: [])
}

enum WidgetStore {
    static let appGroup = "group.dev.varin.mobile"
    static let snapshotKey = "widgetSnapshot"

    /// Reads the latest snapshot the app persisted. Returns `.empty` when nothing has been
    /// written yet (fresh install / app never foregrounded) so widgets render a clean state.
    static func load() -> WidgetSnapshot {
        guard let defaults = UserDefaults(suiteName: appGroup),
              let json = defaults.string(forKey: snapshotKey),
              let data = json.data(using: .utf8),
              let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data) else {
            return .empty
        }
        return snapshot
    }
}

// MARK: - Deep links (mirror packages/ui/src/apps/deepLinks.ts)

enum WidgetDeepLink {
    static func newSession() -> URL { URL(string: "varin://new")! }
    static func attention() -> URL { URL(string: "varin://sessions?filter=attention")! }
    static func status() -> URL { URL(string: "varin://status")! }
    static func settings() -> URL { URL(string: "varin://settings")! }
    static func changes() -> URL { URL(string: "varin://changes")! }
    static func files() -> URL { URL(string: "varin://view/files")! }
    static func instances() -> URL { URL(string: "varin://view/instances")! }
    static func thread(_ thread: WidgetThread) -> URL {
        URL(string: thread.url) ?? newSession()
    }
}

// MARK: - Timeline provider

struct OverviewEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
}

struct OverviewProvider: TimelineProvider {
    func placeholder(in context: Context) -> OverviewEntry {
        OverviewEntry(date: Date(), snapshot: .empty)
    }

    func getSnapshot(in context: Context, completion: @escaping (OverviewEntry) -> Void) {
        completion(OverviewEntry(date: Date(), snapshot: WidgetStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<OverviewEntry>) -> Void) {
        // The app/NSE reload timelines (WidgetCenter) when the snapshot changes, but with several
        // widgets sharing the app's WidgetKit reload budget iOS can refresh them unevenly and
        // leave one stale. Ask for a periodic refresh too so every widget independently re-reads
        // the shared snapshot and converges to the latest state (budget permitting).
        let entry = OverviewEntry(date: Date(), snapshot: WidgetStore.load())
        let nextRefresh = Date().addingTimeInterval(10 * 60)
        completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
    }
}

// MARK: - Varin logo

/// The shared fold mark is emitted into this symbol by `branding:generate`.
/// Using its template rendering keeps Lock Screen and Control Center system tint intact.
struct VarinLogoView: View {
    var body: some View {
        Image("VarinLogoSymbol")
            .resizable()
            .scaledToFit()
            .accessibilityHidden(true)
    }
}
