import Foundation

public struct BrowserNetworkView: Decodable, Sendable {
  public struct Settings: Decodable, Sendable {
    public let mode: String
    public let machineId: String?
    public let revision: Int
    public let sourceOrder: [String]
  }
  public struct Runtime: Decodable, Sendable {
    public let routeEpoch: String?
    public let state: String
    public let activeMachineId: String?
    public let connectivity: BrowserNetworkConnectivity?
  }
  public struct Device: Decodable, Sendable, Identifiable {
    public let machineId: String
    public let label: String
    public let enabled: Bool
    public let connected: Bool
    public let sharingAllowed: Bool
    public let working: Bool?
    public var id: String { machineId }
  }
  public let settings: Settings
  public let runtime: Runtime
  public let devices: [Device]
  public var connectivity: BrowserNetworkConnectivity? {
    guard ["ready", "server"].contains(runtime.state), let value = runtime.connectivity,
      value.epoch == runtime.routeEpoch,
      value.sourceId == (runtime.state == "server" ? "server" : runtime.activeMachineId) else { return nil }
    return value
  }
  public var order: [String] {
    if settings.mode == "device", let id = settings.machineId { return [id, "server"] }
    return settings.sourceOrder.isEmpty ? ["server"] : settings.sourceOrder
  }
  public func name(_ id: String) -> String {
    id == "server" ? "Server connection" : devices.first { $0.id == id }?.label ?? "Unavailable computer"
  }
  public func status(_ id: String) -> String {
    if (runtime.state == "server" && id == "server") ||
      (runtime.state == "ready" && runtime.activeMachineId == id) { return "In use" }
    if id == "server" { return "Available" }
    guard let device = devices.first(where: { $0.id == id }), device.enabled else { return "Unavailable" }
    return device.connected && device.sharingAllowed ? "Available" : "Offline or sharing off"
  }
  public func working(_ id: String) -> Bool {
    if id == "server" { return true }
    guard let device = devices.first(where: { $0.id == id }), device.enabled else { return false }
    return device.working ?? (device.connected && device.sharingAllowed)
  }
  public var internetUnavailable: Bool {
    connectivity?.ipv4.state == "unavailable" && connectivity?.ipv6.state == "unavailable"
  }
  public var summary: String {
    if internetUnavailable {
      return "No internet through \(runtime.state == "server" ? "the server connection" : name(runtime.activeMachineId ?? ""))"
    }
    switch runtime.state {
    case "server": return "Using the server connection"
    case "ready": return "Using \(name(runtime.activeMachineId ?? ""))"
    case "applying": return "Changing browser connection…"
    case "update_required": return "Update or reconnect the computer runtime"
    default: return "Browser network unavailable"
    }
  }
}
public struct BrowserNetworkConnectivity: Decodable, Sendable {
  public struct Family: Decodable, Sendable {
    public let state: String
    public let reason: String?
    public var label: String {
      switch state { case "working": "Working"; case "unavailable": "Unavailable"; default: "Checking…" }
    }
  }
  public let epoch: String
  public let sourceId: String
  public let checkedAt: String?
  public let ipv4: Family
  public let ipv6: Family
}
public enum BrowserNetworkRequest {
  public static let path = "/api/v0/server-settings/browser-network"
  public static func priority(_ order: [String], revision: Int) -> JSON {
    .object([
      "expectedRevision": .number(Double(revision)), "mode": .string("ranked"),
      "machineId": .null, "sourceOrder": .array(order.map(JSON.string)),
    ])
  }
}

public struct BrowserNetworkEgress: Decodable, Sendable {
  public let epoch: String
  public let sourceId: String
  public let ip: String
  public let location: String
  public let checkedAt: String
}

public struct BrowserNetworkQuality: Decodable, Sendable {
  public let epoch: String
  public let sourceId: String
  public let checkedAt: String
  public let latencyMs: Int
  public let downloadMbps: Double
  public let uploadMbps: Double
  public let downloadBytes: Int
  public let uploadBytes: Int
}
