import Foundation

/// Presentation only. Never persist connection records, grants, credentials, or
/// connection status just to draw the inbox shortcut. SavedState scopes this to
/// the authenticated server and user, alongside the cached conversation list.
public struct SidebarPlugin: Codable, Sendable, Equatable, Identifiable {
  public var id: String
  public var name: String
  public var logo: String?

  public var artwork: JSON {
    .object(["pluginKey": .string(id), "name": .string(name), "logoUrl": .string(logo ?? "")])
  }

  /// A missing/malformed list is not an authoritative uninstall-all response.
  public static func snapshot(_ response: JSON) -> [Self]? {
    guard case .array(let installs) = response["installs"] else { return nil }
    var seen: Set<String> = []
    var result: [Self] = []
    for plugin in installs {
      let key = [plugin["pluginKey"].string, plugin["key"].string].first { !$0.isEmpty } ?? ""
      guard !key.isEmpty else { return nil }
      guard seen.insert(key).inserted else { continue }
      let catalog = response["catalog"].array.first { $0["key"].string == key }
      let name = [plugin["name"].string, catalog?["name"].string ?? "", key].first { !$0.isEmpty }!
      // Standard artwork is packaged in Assets.car. Preserve bounded inline
      // custom artwork too; the tiny footer must never start remote image loads.
      let logo = [plugin["logoUrl"].string, plugin["catalog"]["logoUrl"].string,
        catalog?["logoUrl"].string ?? ""].first {
          $0.hasPrefix("data:image/") && $0.contains(";base64,") && $0.utf8.count <= 350_000
        }
      result.append(Self(id: key, name: name, logo: logo))
    }
    return result
  }
}
