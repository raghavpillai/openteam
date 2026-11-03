import SwiftUI

/// The zone routines, the box clock and the bot's sense of time use: auto-detected from
/// this device, or an override.
struct TimeZoneSettingsView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var detected: String?
  @State private var override: String?
  @State private var loaded = false
  @State private var failure: String?
  @State private var query = ""
  private let zones = TimeZone.knownTimeZoneIdentifiers.sorted()

  static func label(_ zone: String) -> String { zone.replacingOccurrences(of: "_", with: " ") }

  private var autoLabel: String {
    detected.map { "Auto-detect (\(Self.label($0)))" } ?? "Auto-detect"
  }
  private var results: [String] {
    let needle = query.lowercased().replacingOccurrences(of: "_", with: " ")
    guard !needle.isEmpty else { return zones }
    return zones.filter { Self.label($0).lowercased().contains(needle) }
  }

  var body: some View {
    List {
      if let failure {
        Text(failure).font(.footnote).foregroundStyle(.red)
      }
      if query.isEmpty {
        row(autoLabel, zone: detected, selected: loaded && override == nil) { save(nil) }
      }
      ForEach(results, id: \.self) { zone in
        row(Self.label(zone), zone: zone, selected: override == zone) { save(zone) }
      }
    }
    .listStyle(.insetGrouped)
    .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search timezone")
    .navigationTitle("Timezone").navigationBarTitleDisplayMode(.inline)
    .task { await load() }
  }

  private func row(_ title: String, zone: String?, selected: Bool, action: @escaping () -> Void)
    -> some View
  {
    Button(action: action) {
      HStack {
        Text(title).foregroundStyle(NativePalette.text)
        Spacer()
        if let zone, let time = Self.time(in: zone) {
          Text(time).foregroundStyle(NativePalette.muted)
        }
        Image(systemName: "checkmark").opacity(selected ? 1 : 0)
      }
    }
  }

  static func time(in zone: String) -> String? {
    guard let timeZone = TimeZone(identifier: zone) else { return nil }
    let formatter = DateFormatter()
    formatter.timeZone = timeZone
    formatter.timeStyle = .short
    return formatter.string(from: Date())
  }

  private func apply(_ value: JSON) {
    let detectedZone = value["detectedTimeZone"].string
    let overrideZone = value["overrideTimeZone"].string
    detected = detectedZone.isEmpty ? nil : detectedZone
    override = overrideZone.isEmpty ? nil : overrideZone
    loaded = true
  }

  private func load() async {
    guard let api = store.api, let value = try? await api.request("/api/v0/time-zone") else { return }
    apply(value)
  }

  private func save(_ zone: String?) {
    guard let api = store.api else { return }
    Task {
      do {
        apply(
          try await api.request(
            "/api/v0/time-zone", method: "PATCH",
            body: .object(["overrideTimeZone": zone.map { .string($0) } ?? .null])))
        failure = nil
        NativeHaptics.play(.selection, source: "settings.timezone")
        dismiss()
      } catch {
        failure = "Couldn't save. Try again."
      }
    }
  }
}
