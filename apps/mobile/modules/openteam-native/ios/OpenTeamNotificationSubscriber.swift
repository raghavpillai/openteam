import UserNotifications
#if canImport(UIKit)
import ExpoModulesCore
import UIKit
#endif

// Read cursors survive background launches and are monotonic when APNs reorders pushes.
enum OpenTeamNotificationReads {
  private static let queue = DispatchQueue(label: "dev.openteam.notification-reads")
  private static let key = "openteam.notification-read-cursors.v1"

  static func data(_ info: [AnyHashable: Any]) -> [String: Any] {
    if let body = info["body"] as? [String: Any] { return body }
    if let data = info["data"] as? [String: Any] { return data }
    return info.reduce(into: [:]) { result, pair in
      if let key = pair.key as? String { result[key] = pair.value }
    }
  }

  static func isRead(_ payload: [String: Any], _ read: [String: String]) -> Bool {
    let messageSequence = (payload["messageSequence"] as? String).flatMap(UInt64.init)
    let sequence: UInt64?
    let watermark: UInt64
    if payload["kind"] as? String == "reaction" || messageSequence == nil {
      sequence = (payload["notificationSequence"] as? String).flatMap(UInt64.init)
      watermark = UInt64(read["lastReadNotificationSequence"] ?? "0") ?? 0
    } else {
      sequence = messageSequence
      watermark = UInt64(read["lastReadSequence"] ?? "0") ?? 0
    }
    return sequence.map { $0 <= watermark } ?? false
  }

  static func reconcile(_ states: [[String: String]], completion: @escaping () -> Void) {
    queue.async {
      var stored = UserDefaults.standard.dictionary(forKey: key) as? [String: [String: String]] ?? [:]
      for state in states {
        guard let channelId = state["channelId"], !channelId.isEmpty else { continue }
        var cursor = stored[channelId] ?? [:]
        for field in ["lastReadSequence", "lastReadNotificationSequence"] {
          guard let raw = state[field], let next = UInt64(raw) else { continue }
          cursor[field] = String(max(UInt64(cursor[field] ?? "0") ?? 0, next))
        }
        stored[channelId] = cursor
      }
      UserDefaults.standard.set(stored, forKey: key)
      UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
        queue.async {
          let current = UserDefaults.standard.dictionary(forKey: key) as? [String: [String: String]] ?? [:]
          let identifiers = notifications.compactMap { notification -> String? in
            let payload = data(notification.request.content.userInfo)
            guard let channelId = payload["channelId"] as? String, let read = current[channelId] else { return nil }
            guard isRead(payload, read) else { return nil }
            return notification.request.identifier
          }
          UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
          completion()
        }
      }
    }
  }
}

#if canImport(UIKit)
public class OpenTeamNotificationSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    let payload = OpenTeamNotificationReads.data(userInfo)
    let state = payload["readState"] as? [String: String]
    OpenTeamNotificationReads.reconcile(state.map { [$0] } ?? []) {
      completionHandler(state == nil ? .noData : .newData)
    }
  }

  public func applicationDidBecomeActive(_ application: UIApplication) {
    OpenTeamNotificationReads.reconcile([]) {}
  }
}
#endif
