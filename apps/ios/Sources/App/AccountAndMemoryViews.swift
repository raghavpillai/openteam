import SwiftUI

struct AccountConnectionView: View {
  @Environment(AppStore.self) private var store
  var body: some View {
    NativeForm {
      Section("Account") {
        LabeledContent("Name", value: store.accountDisplayName)
          .accessibilityIdentifier("account-name")
      }
      Section("Connection") {
        LabeledContent("Server", value: store.accountServer)
          .textSelection(.enabled).accessibilityIdentifier("account-server")
        LabeledContent("Connection", value: store.online ? "Connected" : "Offline")
          .accessibilityElement(children: .ignore).accessibilityLabel("Connection")
          .accessibilityValue(store.online ? "Connected" : "Offline").accessibilityIdentifier(
            "account-connection-status")
      }
      Section {
        Button("Re-auth", role: .destructive) {
          NativeHaptics.play(.light, source: "settings.re-auth")
          store.beginReauthentication()
        }.foregroundStyle(NativePalette.destructive).accessibilityIdentifier("re-auth")
      } footer: {
        Text("Clear all local data, then sign in again or change your server.")
      }
      Section("About") {
        LabeledContent(
          "Version",
          value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")
        LabeledContent("System", value: "iOS " + UIDevice.current.systemVersion)
        Button("Copy version info", systemImage: "doc.on.doc") {
          UIPasteboard.general.string =
            "OpenTeam \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")\niOS \(UIDevice.current.systemVersion)"
        }
      }
    }.navigationTitle("Account").navigationBarTitleDisplayMode(.inline)
  }
}

struct NativePreferencesView: View {
  @Environment(\.openURL) private var openURL
  var body: some View {
    NativeForm {
      Section { NavigationLink("Organize conversations") { SidebarSettingsView() } }
      Section("System preferences") {
        LabeledContent(
          "Language",
          value: Locale.current.localizedString(
            forLanguageCode: Locale.current.language.languageCode?.identifier ?? "en") ?? "System")
        LabeledContent("Time zone", value: TimeZone.current.identifier)
        Button("Open iOS Settings", systemImage: "arrow.up.right") {
          openURL(URL(string: UIApplication.openSettingsURLString)!)
        }
        Text("OpenTeam follows your iPhone’s language, text size and time zone.").font(.footnote)
          .foregroundStyle(NativePalette.muted)
      }
      Section { NavigationLink("Auto-review rules") { AutoReviewRulesView() } }
    }.navigationTitle("Preferences").navigationBarTitleDisplayMode(.inline)
  }
}

struct RobotIdentityPicker: View {
  @Binding var icon: String
  @Binding var color: String
  var showsPreview = true
  private let columns = Array(repeating: GridItem(.fixed(44), spacing: 9), count: 6)
  var body: some View {
    VStack(spacing: 20) {
      if showsPreview {
        BotGlyph(color: Color(hex: color), kind: icon, size: 100, mode: .idle).frame(
          maxWidth: .infinity)
      }
      LazyVGrid(columns: columns, spacing: 12) {
        ForEach(RobotShape.allCases, id: \.rawValue) { shape in
          Button {
            if icon != shape.rawValue { NativeHaptics.play(.selection, source: "bot.shape") }
            icon = shape.rawValue
          } label: {
            BotGlyph(color: Color(hex: color), kind: shape.rawValue, size: 38, mode: .idle)
              .padding(3).background(
                icon == shape.rawValue ? NativePalette.selection : .clear,
                in: RoundedRectangle(cornerRadius: 12)
              ).contentShape(Rectangle())
          }.buttonStyle(.plain).accessibilityLabel(shape.rawValue)
            .accessibilityIdentifier("profile-robot-" + shape.rawValue)
            .accessibilityValue(icon == shape.rawValue ? "Selected" : "")
            .accessibilityAddTraits(icon == shape.rawValue ? .isSelected : [])
        }
      }
      VStack(spacing: 13) {
        colorRow(Array(RobotArtwork.shared.colors.prefix(6)))
        colorRow(Array(RobotArtwork.shared.colors.suffix(5)))
      }
    }.padding(.vertical, 8)
  }
  private func colorRow(_ values: [String]) -> some View {
    HStack(spacing: 22) {
      ForEach(values, id: \.self) { value in
        Button {
          if color != value { NativeHaptics.play(.selection, source: "bot.color") }
          color = value
        } label: {
          Circle().fill(Color(hex: value)).frame(width: 25, height: 25).padding(3)
            .overlay(
              Circle().stroke(
                color.lowercased() == value.lowercased() ? NativePalette.muted : .clear,
                lineWidth: 2))
        }.buttonStyle(.plain).accessibilityLabel("Color " + value)
      }
    }.frame(maxWidth: .infinity)
  }

}
