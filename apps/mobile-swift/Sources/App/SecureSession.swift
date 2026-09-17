import Foundation
import Security

enum SecureSession {
  static let service = "dev.openteam.mobile.swift.session"
  static func read() throws -> SessionRecord? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: "current", kSecReturnData as String: true,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw APIError("Could not read your saved session from Keychain.")
    }
    return try JSONDecoder().decode(SessionRecord.self, from: data)
  }
  static func save(_ record: SessionRecord) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: "current",
    ]
    let data = try JSONEncoder().encode(record)
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      guard
        SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
          == errSecSuccess
      else { throw APIError("Could not save your session securely.") }
    } else if status != errSecSuccess {
      throw APIError("Could not update your saved session.")
    }
  }
  static func clear() throws {
    let status = SecItemDelete(
      [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw APIError("Could not clear your saved session.")
    }
  }
}
