import CryptoKit
import Observation
import SwiftUI
import UIKit
import UserNotifications

@MainActor @Observable
final class NativeNotifications {
  static let shared = NativeNotifications()
  private let center = UNUserNotificationCenter.current()
  private let defaults = UserDefaults.standard
  private var session: SessionRecord?
  private var api: API?
  private var token: String?
  private var epoch = UUID()
  private var snapshotRequest = 0
  private var registering: Task<Void, Never>?
  private var registeredKey: String?
  private var retiring = false
  private var pendingTap: NativePush?
  private var reads = NotificationReads(scope: "")
  #if DEBUG && targetEnvironment(simulator)
    private var didResetQA = false
  #endif
  weak var store: AppStore?
  var permission: UNAuthorizationStatus = .notDetermined
  var failure: String?
  var registered = false
  private(set) var enabled =
    UserDefaults.standard.object(forKey: "native-push-enabled") as? Bool ?? true
  private(set) var changingPermission = false
  var available: Bool {
    #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("--ui-testing") {
        return ProcessInfo.processInfo.arguments.contains("--qa-native-push")
      }
    #endif
    return true
  }
  static func scope(_ record: SessionRecord) -> String {
    SHA256.hash(data: Data((record.server + "\n" + record.userID).utf8)).map {
      String(format: "%02x", $0)
    }.joined()
  }
  private var ledgerKey: String { "native-push-reads:" + reads.scope }
  private func installation(_ scope: String) -> String {
    let key = "native-push-installation:" + scope
    if let value = defaults.string(forKey: key) { return value }
    let value = UUID().uuidString
    defaults.set(value, forKey: key)
    return value
  }
  func bind(_ record: SessionRecord) {
    guard available else { return }
    let scope = Self.scope(record)
    #if DEBUG && targetEnvironment(simulator)
      if ProcessInfo.processInfo.arguments.contains("--qa-native-push"),
        ProcessInfo.processInfo.arguments.contains("--qa-push-reset"), !didResetQA
      {
        didResetQA = true
        defaults.removeObject(forKey: "native-push-reads:" + scope)
        defaults.set(true, forKey: "native-push-enabled")
        enabled = true
        center.removeAllDeliveredNotifications()
      }
    #endif
    if retiring || session?.server != record.server || session?.userID != record.userID
      || session?.token != record.token
    {
      epoch = UUID()
      registeredKey = nil
      registered = false
    }
    session = record
    #if DEBUG && targetEnvironment(simulator)
      if ProcessInfo.processInfo.arguments.contains("--qa-push-cold-launch"),
        record.token == nil, record.mode == "disabled",
        ["127.0.0.1", "localhost"].contains(URL(string: record.server)?.host ?? ""),
        let data = try? JSONEncoder().encode(record)
      {
        defaults.set(data, forKey: "qa-native-push-cold-session")
      }
    #endif
    api = try? API(server: record.server, token: record.token, timeout: 10)
    if reads.scope != scope {
      reads =
        (defaults.data(forKey: "native-push-reads:" + scope).flatMap {
          try? JSONDecoder().decode(NotificationReads.self, from: $0)
        }).flatMap { $0.scope == scope ? $0 : nil } ?? NotificationReads(scope: scope)
    }
    retiring = false
  }
  func restoreBackgroundSession() {
    #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("--ui-testing") { return }
    #endif
    guard available, session == nil, let record = try? SecureSession.read() else { return }
    bind(record)
  }
  func resume(requestPermission: Bool = false) async {
    guard available, session != nil, !retiring else { return }
    let current = epoch
    permission = await center.notificationSettings().authorizationStatus
    guard current == epoch else { return }
    if requestPermission, enabled, permission == .notDetermined {
      do {
        _ = try await center.requestAuthorization(options: [.alert, .badge, .sound])
        guard current == epoch else { return }
        permission = await center.notificationSettings().authorizationStatus
      } catch { failure = UserFacingError.message(error) }
    }
    guard current == epoch else { return }
    if enabled, [.authorized, .provisional, .ephemeral].contains(permission) {
      UIApplication.shared.registerForRemoteNotifications()
      #if DEBUG && targetEnvironment(simulator)
        let args = ProcessInfo.processInfo.arguments
        if args.contains("--qa-native-push"), let i = args.firstIndex(of: "--qa-push-token"),
          args.indices.contains(i + 1)
        {
          didRegister(args[i + 1])
        }
      #endif
      registerToken()
    } else if defaults.string(forKey: "native-push-installation:" + reads.scope) != nil {
      do {
        try await retire()
        retiring = false
      } catch { failure = UserFacingError.message(error) }
    }
    _ = await synchronize()
    await routePendingTap()
  }
  func setEnabled(_ value: Bool) async {
    guard available, !changingPermission else { return }
    changingPermission = true
    defer { changingPermission = false }
    failure = nil
    if !value {
      do {
        try await retire()
        defaults.set(false, forKey: "native-push-enabled")
        enabled = false
        retiring = false
      } catch { failure = UserFacingError.message(error) }
    } else {
      defaults.set(true, forKey: "native-push-enabled")
      enabled = true
      await resume(requestPermission: true)
    }
  }
  func didRegister(_ value: String) {
    guard value.count >= 64, value.count <= 200, value.allSatisfy(\.isHexDigit) else { return }
    token = value.lowercased()
    registerToken()
  }
  func registrationFailed() {
    guard available else { return }
    registered = false
    failure =
      "This iPhone couldn’t register for notifications. Check your connection and try again."
  }
  private func registerToken() {
    guard available, enabled, !retiring,
      [.authorized, .provisional, .ephemeral].contains(permission),
      let token, let api, session != nil, registering == nil
    else { return }
    let scope = reads.scope
    let key = scope + ":" + token
    guard registeredKey != key else { return }
    let current = epoch
    let installationID = installation(scope)
    let environment = Bundle.main.object(forInfoDictionaryKey: "APNsEnvironment") as? String ?? ""
    registering = Task {
      do {
        _ = try await api.request(
          "/api/v0/notification-devices", method: "POST",
          body: .object([
            "installationId": .string(installationID), "platform": .string("ios"),
            "provider": .string("apns"), "pushToken": .string(token),
            "apnsEnvironment": .string(environment),
            "apnsTopic": .string(Bundle.main.bundleIdentifier ?? ""),
            "notificationScope": .string(scope), "timeZone": .string(TimeZone.current.identifier),
            "locale": .string(Locale.current.identifier),
          ]))
        if current == epoch {
          registeredKey = key
          registered = true
          failure = nil
        }
      } catch {
        if current == epoch {
          registered = false
          failure =
            "Notifications couldn’t connect to your server. " + UserFacingError.message(error)
        }
      }
      registering = nil
      if current != epoch { registerToken() }
      // Token rotation during an in-flight registration must not lose the new token.
      if current == epoch, registeredKey == key, self.token != token { registerToken() }
    }
  }
  /// Await a registration already in flight before unregistering. Otherwise its
  /// late response could re-enable notifications after logout or a server switch.
  func retire() async throws {
    guard available else { return }
    retiring = true
    epoch = UUID()
    let current = epoch
    await registering?.value
    guard current == epoch, !Task.isCancelled else { throw CancellationError() }
    guard let api, !reads.scope.isEmpty else { return }
    guard let installationID = defaults.string(forKey: "native-push-installation:" + reads.scope)
    else {
      await clearDelivered()
      return
    }
    do {
      _ = try await api.request(
        "/api/v0/notification-devices/" + API.segment(installationID), method: "DELETE")
    } catch let error as APIError where [401, 403, 404].contains(error.status) {
      // Missing device or expired session cannot receive server notifications.
    } catch {
      guard current == epoch, !Task.isCancelled else { throw CancellationError() }
      retiring = false
      throw APIError("Couldn’t disconnect notifications from this server. Reconnect and try again.")
    }
    guard current == epoch, !Task.isCancelled else { throw CancellationError() }
    registered = false
    registeredKey = nil
    await clearDelivered()
  }
  func reset() {
    epoch = UUID()
    retiring = true
    session = nil
    api = nil
    registeredKey = nil
    registered = false
    pendingTap = nil
    reads = NotificationReads(scope: "")
    center.removeAllDeliveredNotifications()
    center.removeAllPendingNotificationRequests()
    Task { try? await center.setBadgeCount(0) }
  }
  /// Local reset must finish offline. Retire the old server registration independently.
  func forgetLocally() {
    let oldAPI = api
    let installationID = defaults.string(forKey: "native-push-installation:" + reads.scope)
    let pendingRegistration = registering
    reset()
    token = nil
    enabled = true
    failure = nil
    changingPermission = false
    UIApplication.shared.unregisterForRemoteNotifications()
    Task {
      await pendingRegistration?.value
      if let oldAPI, let installationID {
        _ = try? await oldAPI.request(
          "/api/v0/notification-devices/" + API.segment(installationID), method: "DELETE")
      }
    }
  }
  private func clearDelivered() async {
    center.removeAllDeliveredNotifications()
    center.removeAllPendingNotificationRequests()
    try? await center.setBadgeCount(0)
  }
  private func saveReads() {
    if !reads.scope.isEmpty, let data = try? JSONEncoder().encode(reads) {
      defaults.set(data, forKey: ledgerKey)
    }
  }
  func apply(channels: [Channel]) {
    guard available, session != nil else { return }
    for channel in channels {
      var value = channel.notificationState ?? .null
      value["channelId"] = .string(channel.id)
      if let marker = NotificationReadMarker(json: value) { reads.merge(marker) }
    }
    saveReads()
    Task {
      await removeReadNotifications()
      _ = await synchronize()
      await reportForQA(nil)
    }
  }
  @discardableResult func synchronize() async -> Bool {
    guard available, let api, !retiring else { return false }
    let current = epoch
    snapshotRequest += 1
    let request = snapshotRequest
    do {
      let value = try await api.request("/api/v0/notification-state")
      guard current == epoch, request == snapshotRequest else { return false }
      let freshBadge = reads.apply(snapshot: value)
      saveReads()
      await removeReadNotifications()
      if current == epoch, freshBadge, let badge = reads.badgeCount {
        try? await center.setBadgeCount(enabled ? badge : 0)
      }
      return true
    } catch { return false }  // An offline read marker still retires known notifications.
  }
  func receive(_ push: NativePush) async -> Bool {
    restoreBackgroundSession()
    guard available, session != nil, push.scope == reads.scope else { return false }
    if let marker = push.readMarker {
      reads.merge(marker)
      saveReads()
    }
    await removeReadNotifications()
    let result = await synchronize()
    await reportForQA(push)
    return result
  }
  private func removeReadNotifications() async {
    let current = epoch
    let delivered = await center.deliveredNotifications()
    guard current == epoch else { return }
    let ids = delivered.compactMap { item -> String? in
      let push = Self.payload(item.request.content.userInfo)
      return reads.hasRead(push) || (!push.scope.isEmpty && push.scope != reads.scope)
        ? item.request.identifier : nil
    }
    center.removeDeliveredNotifications(withIdentifiers: ids)
  }
  func shouldPresent(_ push: NativePush) -> Bool {
    guard available, session != nil, enabled, push.scope == reads.scope, push.isAlert,
      !reads.hasRead(push)
    else { return false }
    return
      !(UIApplication.shared.applicationState == .active && store?.activeChannel == push.channelId)
  }
  func tapped(_ push: NativePush) async {
    guard push.isAlert else { return }
    pendingTap = push
    await routePendingTap()
  }
  func routePendingTap() async {
    guard let push = pendingTap, let store, store.phase == .ready else { return }
    let current = epoch
    pendingTap = nil
    guard push.scope == reads.scope else { return }
    if store.channel(push.channelId) == nil { await store.refresh() }
    guard current == epoch, push.scope == reads.scope, store.phase == .ready else { return }
    guard store.channel(push.channelId) != nil else {
      store.error = "This conversation is no longer available."
      return
    }
    await store.open(push.channelId)
  }
  nonisolated static func payload(_ userInfo: [AnyHashable: Any]) -> NativePush {
    let value =
      (try? JSONSerialization.data(withJSONObject: userInfo)).flatMap {
        try? JSONDecoder().decode(JSON.self, from: $0)
      } ?? .null
    return NativePush(value)
  }
  private func reportForQA(_ push: NativePush?) async {
    #if DEBUG && targetEnvironment(simulator)
      guard ProcessInfo.processInfo.arguments.contains("--qa-native-push"), let api,
        ["127.0.0.1", "localhost"].contains(api.baseURL.host ?? "")
      else { return }
      // Inspect the actual iOS notification center. No fabricated delivered list.
      let delivered = await center.deliveredNotifications()
      _ = try? await api.request(
        "/__push/observation", method: "POST",
        body: .object([
          "probe": .string(push?.data["probe"].string ?? "foreground"),
          "trigger": .string(push?.data["qaID"].string ?? ""),
          "delivered": .array(
            delivered.map { .string(Self.payload($0.request.content.userInfo).data["qaID"].string) }
          ),
          "badge": .number(Double(UIApplication.shared.applicationIconBadgeNumber)),
          "permission": .number(Double(permission.rawValue)),
          "registered": .bool(registered),
        ]))
    #endif
  }
}

@MainActor
final class NotificationAppDelegate: NSObject, UIApplicationDelegate,
  UNUserNotificationCenterDelegate
{
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    NativeNotifications.shared.restoreBackgroundSession()
    return true
  }
  func application(
    _ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    #if DEBUG && targetEnvironment(simulator)
      if ProcessInfo.processInfo.arguments.contains("--qa-push-token") { return }
    #endif
    NativeNotifications.shared.didRegister(deviceToken.map { String(format: "%02x", $0) }.joined())
  }
  func application(
    _ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    #if DEBUG && targetEnvironment(simulator)
      if ProcessInfo.processInfo.arguments.contains("--qa-push-token") { return }
    #endif
    NativeNotifications.shared.registrationFailed()
  }
  func application(
    _ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]
  ) async -> UIBackgroundFetchResult {
    await NativeNotifications.shared.receive(NativeNotifications.payload(userInfo))
      ? .newData : .noData
  }
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    let push = NativeNotifications.payload(notification.request.content.userInfo)
    return await MainActor.run {
      let manager = NativeNotifications.shared
      Task { _ = await manager.receive(push) }
      guard manager.shouldPresent(push) else { return [] }
      return ["message", "reaction", "agent-needs-input"].contains(push.data["kind"].string)
        ? [.banner, .list, .sound] : [.banner, .list]
    }
  }
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    guard response.actionIdentifier != UNNotificationDismissActionIdentifier else { return }
    await NativeNotifications.shared.tapped(
      NativeNotifications.payload(response.notification.request.content.userInfo))
  }
}

struct PushNotificationSettings: View {
  private var notifications: NativeNotifications { .shared }
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Toggle(
        "Notifications",
        isOn: Binding(
          get: { notifications.enabled && notifications.permission != .denied },
          set: { value in Task { await notifications.setEnabled(value) } })
      )
      .accessibilityIdentifier("push-notifications-toggle").tint(NativePalette.toggle).disabled(
        notifications.changingPermission)
      if notifications.permission == .denied {
        Button("Allow notifications in iPhone Settings") {
          UIApplication.shared.open(URL(string: UIApplication.openNotificationSettingsURLString)!)
        }
      } else if let failure = notifications.failure {
        Text(failure).font(.footnote).foregroundStyle(NativePalette.muted)
        Button("Retry notifications") {
          Task { await notifications.resume(requestPermission: true) }
        }
        .accessibilityIdentifier("push-notifications-retry")
      } else if notifications.enabled && notifications.permission == .notDetermined {
        Button("Enable notifications") {
          Task { await notifications.resume(requestPermission: true) }
        }
      }
    }.task { await notifications.resume() }
  }
}
