import Foundation

/// SemVer ordering shared with contracts/version-compatibility.ts. Build metadata
/// does not affect ordering; malformed versions never become update targets.
public struct OpenTeamVersion: Comparable, Sendable {
  public let major: Int
  public let minor: Int
  public let patch: Int
  private let prerelease: [String]
  public let normalized: String

  public init?(_ raw: String) {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let pattern =
      #"^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"#
    guard value.range(of: pattern, options: .regularExpression) == value.startIndex..<value.endIndex
    else { return nil }
    let withoutBuild = String(value.split(separator: "+", maxSplits: 1)[0])
    let pieces = withoutBuild.split(separator: "-", maxSplits: 1)
    let numbers = pieces[0].replacingOccurrences(of: "v", with: "").split(separator: ".").compactMap
    { Int($0) }
    guard numbers.count == 3, numbers.allSatisfy({ $0 <= 9_007_199_254_740_991 }) else {
      return nil
    }
    major = numbers[0]
    minor = numbers[1]
    patch = numbers[2]
    prerelease = pieces.count == 2 ? pieces[1].split(separator: ".").map(String.init) : []
    normalized =
      "\(major).\(minor).\(patch)"
      + (prerelease.isEmpty ? "" : "-" + prerelease.joined(separator: "."))
  }

  public static func < (a: Self, b: Self) -> Bool {
    for (left, right) in zip([a.major, a.minor, a.patch], [b.major, b.minor, b.patch])
    where left != right {
      return left < right
    }
    if a.prerelease.isEmpty || b.prerelease.isEmpty {
      return !a.prerelease.isEmpty && b.prerelease.isEmpty
    }
    for (left, right) in zip(a.prerelease, b.prerelease) where left != right {
      let leftNumeric = left.allSatisfy(\.isNumber)
      let rightNumeric = right.allSatisfy(\.isNumber)
      if leftNumeric != rightNumeric { return leftNumeric }
      if leftNumeric && left.count != right.count { return left.count < right.count }
      return left < right
    }
    return a.prerelease.count < b.prerelease.count
  }
}

public struct ServerRelease: Codable, Sendable {
  public let releaseVersion: String
  public let apiProtocolVersion: Int?
  public let minimumClientVersion: String?
  public let maximumClientVersionExclusive: String?
}

public struct ServerUpdateStatus: Codable, Sendable {
  public let updaterAvailable: Bool
  public let status: String
  public let targetVersion: String?
  public let jobId: String?
  public let phase: String?
  public let message: String?
  public let safeToCloseDesktop: Bool
  public var updating: Bool { status == "updating" }
}

/// The host's milestones, matching contracts/server-updates.ts. No estimated percentages.
public struct ServerUpdateProgress: Sendable {
  public static let steps = ["Prepare", "Download", "Back up", "Restart", "Verify"]
  public let step: Int?
  public let title: String
  public let rollingBack: Bool
  public init(phase: String?) {
    rollingBack = phase == "rolling-back"
    switch phase {
    case "queued", "checking":
      step = 0
      title = "Preparing update"
    case "downloading":
      step = 1
      title = "Verifying the release"
    case "pulling":
      step = 1
      title = "Downloading update"
    case "backing-up":
      step = 2
      title = "Protecting your data"
    case "restarting":
      step = 3
      title = "Restarting services"
    case "verifying":
      step = 4
      title = "Checking server health"
    case "updating-cli":
      step = 4
      title = "Finishing up"
    case "complete":
      step = 5
      title = "Update complete"
    case "rolling-back":
      step = nil
      title = "Restoring the previous version"
    default:
      step = nil
      title = "Update in progress"
    }
  }
}

public struct ServerUpdatePolicy: Sendable {
  public enum Compatibility: Sendable {
    case unknown, compatible, recommended, serverRequired, clientRequired
  }
  public let compatibility: Compatibility
  public let targetVersion: String?

  public init(clientVersion: String, release: ServerRelease?) {
    guard let client = OpenTeamVersion(clientVersion), let release,
      let server = OpenTeamVersion(release.releaseVersion),
      let protocolVersion = release.apiProtocolVersion,
      let minimum = OpenTeamVersion(
        release.minimumClientVersion ?? "\(server.major).\(server.minor).0"),
      let maximum = OpenTeamVersion(
        release.maximumClientVersionExclusive ?? "\(server.major).\(server.minor + 1).0"),
      let minimumServer = OpenTeamVersion("\(client.major).\(client.minor).0")
    else {
      compatibility = .unknown
      targetVersion = nil
      return
    }
    if protocolVersion > 2 || client < minimum {
      compatibility = .clientRequired
    } else if protocolVersion < 2 || client >= maximum || server < minimumServer {
      compatibility = .serverRequired
    } else {
      compatibility = client == server ? .compatible : .recommended
    }
    // Pin to the installed iOS release; neither a release feed nor a downgrade
    // is needed to bring an older compatible server up to this version.
    targetVersion = compatibility != .clientRequired && client > server ? client.normalized : nil
  }
}

/// Only active progress is cached, scoped to the connected server. Live responses always win.
public struct ServerUpdateSnapshot: Codable, Sendable {
  public let release: ServerRelease?
  public let update: ServerUpdateStatus
  public let observedAt: Date
  public let startedAt: Date?
  public init(
    release: ServerRelease?, update: ServerUpdateStatus, observedAt: Date, startedAt: Date?
  ) {
    self.release = release
    self.update = update
    self.observedAt = observedAt
    self.startedAt = startedAt
  }
}

public enum ServerUpdateCache {
  private static func key(_ server: String) -> String { "openteam-server-update:" + server }
  public static func load(server: String, defaults: UserDefaults = .standard, now: Date = Date())
    -> ServerUpdateSnapshot?
  {
    guard let data = defaults.data(forKey: key(server)),
      let snapshot = try? JSONDecoder().decode(ServerUpdateSnapshot.self, from: data),
      snapshot.update.updating,
      snapshot.update.targetVersion.flatMap(OpenTeamVersion.init) != nil,
      snapshot.observedAt <= now,
      now.timeIntervalSince(snapshot.observedAt) <= 86400,
      snapshot.startedAt.map({ $0 <= now }) ?? true
    else { return nil }
    return snapshot
  }
  public static func save(
    _ snapshot: ServerUpdateSnapshot?, server: String, defaults: UserDefaults = .standard
  ) {
    guard let snapshot, snapshot.update.updating,
      let data = try? JSONEncoder().encode(snapshot)
    else {
      defaults.removeObject(forKey: key(server))
      return
    }
    defaults.set(data, forKey: key(server))
  }
}
