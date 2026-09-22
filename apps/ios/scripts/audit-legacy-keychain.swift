import Foundation
import Security
import UIKit

struct LegacyKeychainAudit {
  static func run() throws {
    // Never query the user's actual Expo services in this host test.
    let service = "dev.openteam.reset-test." + UUID().uuidString
    let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
    defer { SecItemDelete(base as CFDictionary) }
    let keys = ["openteam.auth-token", "openteam.api-access-token.v1", "openteam.auth-mode.v1.0123456789abcdef", "unrelated.setting"]
    for (index, key) in keys.enumerated() {
      var query = base
      query[kSecAttrAccount as String] = index.isMultiple(of: 2) ? key as Any : Data(key.utf8)
      query[kSecAttrGeneric as String] = Data(key.utf8)
      query[kSecValueData as String] = Data("fixture".utf8)
      precondition(SecItemAdd(query as CFDictionary, nil) == errSecSuccess, "Could not create isolated Keychain fixture")
    }
    try LegacySecureStorage.clear(services: [service])
    for (index, key) in keys.enumerated() {
      var query = base
      query[kSecAttrAccount as String] = index.isMultiple(of: 2) ? key as Any : Data(key.utf8)
      precondition(SecItemCopyMatching(query as CFDictionary, nil) == (key.hasPrefix("openteam.") ? errSecItemNotFound : errSecSuccess), "Unexpected key after reset")
    }
    try LegacySecureStorage.clear(services: [service])
    print("PASS: iOS Keychain deletes dynamic and old OpenTeam keys, preserves other namespaces, and retries safely")
  }
}

// Install this audit as its own signed simulator app; a bare CLI has no Keychain identity.
@main struct KeychainAuditRunner {
  @MainActor static func main() {
    UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(KeychainAuditDelegate.self))
  }
}
@MainActor final class KeychainAuditDelegate: NSObject, UIApplicationDelegate {
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    let result: String
    do { try LegacyKeychainAudit.run(); result = "PASS" }
    catch { result = "FAIL: \(error)" }
    let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    try? result.write(to: directory.appendingPathComponent("result.txt"), atomically: true, encoding: .utf8)
    return true
  }
}
