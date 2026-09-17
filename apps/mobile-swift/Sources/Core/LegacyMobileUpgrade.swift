import Foundation

/// Values stored by the React Native app. A bearer is usable only with its saved server/account.
struct LegacyMobileUpgrade {
  static let keys = [
    "openteam.server-url.v1", "openteam.auth-token", "openteam.auth-token-server",
    "openteam.auth-token-account", "openteam.appearance", "openteam.accent",
    "openteam.haptics", "openteam.push-installation-id",
  ]
  let server: String?
  let token: String?
  let account: String?
  let appearance: String?
  let accent: String?
  let haptics: Bool?
  let installationID: String?

  init(values: [String: String]) {
    server = values["openteam.server-url.v1"].flatMap { try? API.normalize($0).absoluteString }
    let boundServer = values["openteam.auth-token-server"].flatMap {
      try? API.normalize($0).absoluteString
    }
    let savedToken = values["openteam.auth-token"]
    let savedAccount = values["openteam.auth-token-account"]
    let validSession =
      server != nil && server == boundServer
      && savedToken?.isEmpty == false && savedAccount?.isEmpty == false
    token = validSession ? savedToken : nil
    account = validSession ? savedAccount : nil
    appearance = values["openteam.appearance"].flatMap {
      ["system", "light", "dark"].contains($0) ? $0 : nil
    }
    accent = values["openteam.accent"].flatMap { ["black", "blue"].contains($0) ? $0 : nil }
    // Match React Native: missing means default on; unrecognized stored values stay off.
    haptics = values["openteam.haptics"].map { $0 == "on" }
    installationID =
      validSession
      ? values["openteam.push-installation-id"].flatMap {
        UUID(uuidString: $0) != nil ? $0 : nil
      } : nil
  }

  func applyPreferences(to defaults: UserDefaults) {
    for (key, value) in ["server": server, "appearance": appearance, "accent": accent] {
      if defaults.object(forKey: key) == nil, let value { defaults.set(value, forKey: key) }
    }
    if defaults.object(forKey: "haptics") == nil, let haptics {
      defaults.set(haptics, forKey: "haptics")
    }
  }
}
