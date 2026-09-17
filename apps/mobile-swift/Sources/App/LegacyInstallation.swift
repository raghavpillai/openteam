import Foundation
import Security

@MainActor
enum LegacyInstallation {
  private static let marker = "native-upgrade-from-react-native-v1"

  static func clear() throws {
    try LegacySecureStorage.clear()
  }

  static func migrate() throws {
    let defaults = UserDefaults.standard
    guard Bundle.main.bundleIdentifier == "dev.openbot.mobile", !defaults.bool(forKey: marker)
    else { return }
    var values: [String: String] = [:]
    // Exact, read-only Expo keys. Leave them intact so the prior beta remains a rollback.
    for key in LegacyMobileUpgrade.keys { values[key] = try readExpoValue(key) }
    let upgrade = LegacyMobileUpgrade(values: values)
    if try SecureSession.read() == nil,
      let server = upgrade.server, let token = upgrade.token, let account = upgrade.account
    {
      let record = SessionRecord(
        server: server, token: token, userID: account, userName: "", mode: "required")
      try SecureSession.save(record)
      if let installationID = upgrade.installationID {
        let key = "native-push-installation:" + NativeNotifications.scope(record)
        if defaults.string(forKey: key) == nil { defaults.set(installationID, forKey: key) }
      }
    }
    upgrade.applyPreferences(to: defaults)
    defaults.set(true, forKey: marker)
  }

  private static func readExpoValue(_ key: String) throws -> String? {
    // These keys were saved without biometric authentication; Expo's original alias is "app".
    for service in ["app:no-auth", "app"] {
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrGeneric as String: Data(key.utf8),
        kSecAttrAccount as String: Data(key.utf8),
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnData as String: true,
      ]
      var result: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &result)
      if status == errSecItemNotFound { continue }
      guard status == errSecSuccess, let data = result as? Data else {
        throw APIError(
          "Could not restore your previous settings. Unlock your device and reopen the app.")
      }
      return String(data: data, encoding: .utf8)
    }
    return nil
  }
}
