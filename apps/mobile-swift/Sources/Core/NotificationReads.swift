import Foundation

/// Message and activity cursors are independent: a new reaction to an old
/// message remains unread until its own notification sequence is acknowledged.
public struct NotificationReadMarker: Codable, Equatable, Sendable {
  public var channelId: String
  public var lastReadSequence: String
  public var lastReadNotificationSequence: String
  public init?(json: JSON) {
    let channel = json["channelId"].string
    guard !channel.isEmpty,
      let message = NotificationReads.sequence(json["lastReadSequence"].string),
      let activity = NotificationReads.sequence(json["lastReadNotificationSequence"].string)
    else { return nil }
    channelId = channel
    lastReadSequence = message
    lastReadNotificationSequence = activity
  }
}

public struct NativePush: Sendable {
  public let data: JSON
  public init(_ payload: JSON) {
    if payload["data"]["kind"] != .null {
      data = payload["data"]
    } else if payload["body"]["kind"] != .null {
      data = payload["body"]
    } else {
      data = payload
    }
  }
  public var scope: String { data["notificationScope"].string }
  public var channelId: String { data["channelId"].string }
  public var isSync: Bool { data["kind"].string == "badge-sync" }
  public var isAlert: Bool {
    ["message", "reaction", "agent-done", "agent-needs-input"].contains(data["kind"].string)
      && !channelId.isEmpty
  }
  public var readMarker: NotificationReadMarker? {
    isSync ? NotificationReadMarker(json: data["readState"]) : nil
  }
}

public struct NotificationReads: Codable, Sendable {
  public var scope: String
  public private(set) var markers: [String: NotificationReadMarker] = [:]
  public private(set) var snapshotCursor: String?
  public private(set) var badgeCount: Int?
  public init(scope: String) { self.scope = scope }

  public static func sequence(_ value: String) -> String? {
    guard !value.isEmpty, value.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else { return nil }
    let canonical = String(value.drop(while: { $0 == "0" }))
    return canonical.isEmpty ? "0" : canonical
  }
  public static func less(_ left: String, _ right: String) -> Bool {
    left.count == right.count ? left < right : left.count < right.count
  }
  public mutating func merge(_ marker: NotificationReadMarker) {
    guard let old = markers[marker.channelId] else {
      markers[marker.channelId] = marker
      return
    }
    var next = old
    if Self.less(old.lastReadSequence, marker.lastReadSequence) {
      next.lastReadSequence = marker.lastReadSequence
    }
    if Self.less(old.lastReadNotificationSequence, marker.lastReadNotificationSequence) {
      next.lastReadNotificationSequence = marker.lastReadNotificationSequence
    }
    markers[marker.channelId] = next
  }
  @discardableResult public mutating func apply(snapshot: JSON) -> Bool {
    guard let cursor = Self.sequence(snapshot["cursor"].string),
      case .array = snapshot["readStates"], case .number(let badge) = snapshot["badgeCount"],
      badge.isFinite, badge >= 0, badge <= Double(Int32.max), badge.rounded(.down) == badge
    else { return false }
    let incoming = snapshot["readStates"].array.compactMap(NotificationReadMarker.init(json:))
    let byChannel = Dictionary(
      incoming.map { ($0.channelId, $0) }, uniquingKeysWith: { _, last in last })
    // A request begun before a newer local/read push acknowledgement must not
    // restore the old badge, even if its event cursor is new to this process.
    let behind = markers.values.contains { old in
      guard let next = byChannel[old.channelId] else {
        return old.lastReadSequence != "0" || old.lastReadNotificationSequence != "0"
      }
      return Self.less(next.lastReadSequence, old.lastReadSequence)
        || Self.less(next.lastReadNotificationSequence, old.lastReadNotificationSequence)
    }
    for marker in incoming { merge(marker) }
    if behind { return false }
    if let old = snapshotCursor, Self.less(cursor, old) { return false }
    snapshotCursor = cursor
    badgeCount = Int(badge)
    return true
  }
  public func hasRead(_ push: NativePush) -> Bool {
    guard push.scope == scope, push.isAlert, let marker = markers[push.channelId] else {
      return false
    }
    let reaction = push.data["kind"].string == "reaction"
    let rawMessage = push.data["messageSequence"].string
    if !reaction, !rawMessage.isEmpty {
      guard let message = Self.sequence(rawMessage) else { return false }
      return !Self.less(marker.lastReadSequence, message)
    }
    guard let activity = Self.sequence(push.data["notificationSequence"].string) else {
      return false
    }
    return !Self.less(marker.lastReadNotificationSequence, activity)
  }
}
