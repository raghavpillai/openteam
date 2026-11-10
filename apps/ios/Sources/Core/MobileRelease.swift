import Foundation

/// Published only after a build is available to the public TestFlight group.
/// This is independent of the server release and the next archive's build number.
public struct MobileRelease: Codable, Equatable, Sendable {
  public let version: String
  public let buildNumber: String
  public let bundleIdentifier: String

  public static let feedURL = URL(string: "https://openteam.so/ios-update.json")!
  public static let testFlightURL = URL(string: "https://testflight.apple.com/join/KFBFPkjP")!
  public static let testFlightAppURL = URL(
    string: "itms-beta://testflight.apple.com/join/KFBFPkjP")!

  public init(version: String, buildNumber: String, bundleIdentifier: String) {
    self.version = version
    self.buildNumber = buildNumber
    self.bundleIdentifier = bundleIdentifier
  }

  public var isValid: Bool {
    Self.components(version) != nil && Self.components(buildNumber) != nil
      && bundleIdentifier == "dev.openbot.mobile"
  }

  public func isNewer(thanVersion version: String, buildNumber: String) -> Bool {
    guard isValid,
      let latestVersion = Self.components(self.version),
      let installedVersion = Self.components(version),
      let latestBuild = Self.components(self.buildNumber),
      let installedBuild = Self.components(buildNumber)
    else { return false }
    if latestVersion != installedVersion {
      return installedVersion.lexicographicallyPrecedes(latestVersion)
    }
    return installedBuild.lexicographicallyPrecedes(latestBuild)
  }

  private static func components(_ value: String) -> [UInt32]? {
    let parts = value.split(separator: ".", omittingEmptySubsequences: false)
    guard (1...3).contains(parts.count) else { return nil }
    var result: [UInt32] = []
    for part in parts {
      guard !part.isEmpty, part.utf8.allSatisfy({ (48...57).contains($0) }),
        let number = UInt32(part)
      else { return nil }
      result.append(number)
    }
    return result + Array(repeating: 0, count: 3 - result.count)
  }
}

public struct MobileReleaseFeed: Decodable, Sendable {
  public let release: MobileRelease?

  private enum CodingKeys: String, CodingKey { case release }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    release = try container.decode(MobileRelease?.self, forKey: .release)
  }

  public static func decode(_ data: Data) throws -> MobileRelease? {
    let feed = try JSONDecoder().decode(Self.self, from: data)
    if let release = feed.release, !release.isValid {
      throw APIError("The mobile update feed is invalid.")
    }
    return feed.release
  }
}
