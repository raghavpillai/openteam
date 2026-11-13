import Foundation

/// Same wire contract as packages/contracts/src/presentation.ts.
public struct PresentationPayload: Codable, Sendable, Equatable {
  public let version: Int
  public let places: [PresentationPlace]
  public let blocks: [PresentationBlock]
  public static func parse(_ json: JSON) -> Self? {
    guard let value = try? json.decode(Self.self), value.version == 1,
      value.places.count <= 50, (1...20).contains(value.blocks.count),
      Set(value.places.map(\.id)).count == value.places.count,
      value.places.allSatisfy({ !$0.id.isEmpty && !$0.name.isEmpty && $0.latitude.isFinite && $0.longitude.isFinite && (-90...90).contains($0.latitude) && (-180...180).contains($0.longitude) })
    else { return nil }
    let ids = Set(value.places.map(\.id))
    for block in value.blocks {
      switch block {
      case .markdown: break
      case .map(let map):
        guard (1...50).contains(map.placeIds.count), Set(map.placeIds).count == map.placeIds.count,
          map.placeIds.allSatisfy(ids.contains), ["auto", "hidden"].contains(map.carousel ?? "auto") else { return nil }
        if let route = map.route {
          guard ["walking", "driving", "cycling"].contains(route.mode), route.geometry.type == "LineString",
            (2...20000).contains(route.geometry.coordinates.count),
            route.geometry.coordinates.allSatisfy({ $0.count == 2 && $0.allSatisfy(\.isFinite) && (-180...180).contains($0[0]) && (-90...90).contains($0[1]) }),
            route.distanceMeters.isFinite, route.distanceMeters >= 0, route.durationSeconds.isFinite, route.durationSeconds >= 0,
            map.placeIds.count >= 2, route.legs.count == map.placeIds.count - 1,
            route.legs.enumerated().allSatisfy({ index, leg in leg.fromPlaceId == map.placeIds[index] && leg.toPlaceId == map.placeIds[index + 1] && leg.durationSeconds.isFinite && leg.durationSeconds >= 0 && leg.distanceMeters.isFinite && leg.distanceMeters >= 0 }) else { return nil }
        }
      case .media(let media):
        guard (1...50).contains(media.items.count), media.items.allSatisfy({ !$0.id.isEmpty && !$0.title.isEmpty && ($0.placeId == nil || ids.contains($0.placeId!)) }) else { return nil }
      }
    }
    return value
  }
}
public struct PresentationPlace: Codable, Identifiable, Sendable, Equatable {
  public let id: String
  public let name: String
  public let latitude: Double
  public let longitude: Double
  public let address: String?
  public let category: String?
  public let icon: String?
  public let description: String?
  public let notes: String?
  public let imageUrl: String?
  public let websiteUrl: String?
  public let rating: Double?
  public let reviewCount: Int?
  public let isOpen: Bool?
  public let hours: String?
  public let provider: String?
  public let sourceUrl: String?
  public let attribution: String?
}
public struct PresentationRoute: Codable, Sendable, Equatable {
  public struct Geometry: Codable, Sendable, Equatable { public let type: String; public let coordinates: [[Double]] }
  public struct Leg: Codable, Sendable, Equatable {
    public let fromPlaceId: String
    public let toPlaceId: String
    public let distanceMeters: Double
    public let durationSeconds: Double
    public let instructions: [String]?
  }
  public let mode: String
  public let geometry: Geometry
  public let distanceMeters: Double
  public let durationSeconds: Double
  public let legs: [Leg]
  public let provider: String?
  public let sourceUrl: String?
  public let attribution: String?
}
public struct PresentationMap: Codable, Sendable, Equatable {
  public let type: String
  public let title: String?
  public let placeIds: [String]
  public let carousel: String?
  public let route: PresentationRoute?
}
public struct PresentationMedia: Codable, Sendable, Equatable {
  public struct Item: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let title: String
    public let description: String?
    public let imageUrl: String?
    public let href: String?
    public let placeId: String?
    public let sourceLabel: String?
    public let sourceUrl: String?
  }
  public let type: String
  public let title: String?
  public let items: [Item]
}
public enum PresentationBlock: Codable, Sendable, Equatable {
  case markdown(String), map(PresentationMap), media(PresentationMedia)
  enum Keys: String, CodingKey { case type, text }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    switch try c.decode(String.self, forKey: .type) {
    case "markdown": self = .markdown(try c.decode(String.self, forKey: .text))
    case "place_map": self = .map(try PresentationMap(from: decoder))
    case "ranked_media_list": self = .media(try PresentationMedia(from: decoder))
    default: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown presentation component")
    }
  }
  public func encode(to encoder: Encoder) throws {
    switch self {
    case .markdown(let text): var c = encoder.container(keyedBy: Keys.self); try c.encode("markdown", forKey: .type); try c.encode(text, forKey: .text)
    case .map(let map): try map.encode(to: encoder)
    case .media(let media): try media.encode(to: encoder)
    }
  }
}
