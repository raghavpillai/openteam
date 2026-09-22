import Foundation
import Security

enum LegacySecureStorage {
  static func clear(services: [String] = ["app:no-auth", "app"]) throws {
    for service in services {
      var result: CFTypeRef?
      let status = SecItemCopyMatching([
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecMatchLimit as String: kSecMatchLimitAll,
        kSecReturnAttributes as String: true,
      ] as CFDictionary, &result)
      if status == errSecItemNotFound { continue }
      guard status == errSecSuccess, let items = result as? [[String: Any]] else {
        throw APIError("Could not clear your previous login. Unlock your device and try again.")
      }
      // Inspect key names only, never credential values. Expo used both string and data accounts.
      for item in items {
        let account = item[kSecAttrAccount as String]
        let key = (account as? String) ?? (account as? Data).flatMap { String(data: $0, encoding: .utf8) }
        guard let key, key.hasPrefix("openteam."), let account else { continue }
        let deleted = SecItemDelete([
          kSecClass as String: kSecClassGenericPassword,
          kSecAttrService as String: service,
          kSecAttrAccount as String: account,
        ] as CFDictionary)
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else {
          throw APIError("Could not clear your previous login. Unlock your device and try again.")
        }
      }
    }
  }
}
