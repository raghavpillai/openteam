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
        Button("Re-auth") {
          NativeHaptics.play(.light, source: "settings.re-auth")
          store.beginReauthentication()
        }.accessibilityIdentifier("re-auth")
      } footer: {
        Text("Sign in again or change your server.")
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
      .sheet(
        isPresented: Binding(
          get: { store.reauthenticating },
          set: { if !$0 { store.cancelReauthentication() } }
        )
      ) {
        SignInView(reauthentication: true)
      }
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
      Section("Auto-review rules") {
        Label("Managed on your computer", systemImage: "checkmark.shield")
        Text(
          "Auto-review protects actions on the computer running OpenTeam. Manage its permission rules in the desktop app."
        )
        .foregroundStyle(NativePalette.muted)
      }
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
            BotGlyph(color: Color(hex: color), kind: shape.rawValue, size: 38)
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

struct BotMemoryView: View {
  @Environment(AppStore.self) private var store
  let bot: Bot
  @State private var value: JSON = .null
  @State private var loading = true
  @State private var failure: String?
  @State private var deleting: JSON?
  @State private var clear = false
  @State private var busy = false
  @State private var query = ""
  private var path: String { "/api/v0/bots/\(API.segment(bot.id))/memories" }
  var body: some View {
    NativeList {
      if loading { ProgressView("Loading memories…") }
      if let failure { InlineFailure(message: failure) { Task { await load() } } }
      ForEach(
        value["memories"].array.filter {
          query.isEmpty || $0["content"].string.localizedCaseInsensitiveContains(query)
        }, id: \.self
      ) { item in
        VStack(alignment: .leading, spacing: 6) {
          Text(item["kind"].string.capitalized).font(.caption).foregroundStyle(NativePalette.muted)
          Text(item["content"].string).textSelection(.enabled)
        }.padding(.vertical, 4).swipeActions(allowsFullSwipe: false) {
          Button("Delete", role: .destructive) { deleting = item }.disabled(busy)
        }
      }
      if !loading, failure == nil, value["memories"].array.isEmpty {
        ContentUnavailableView(
          "No saved memories", systemImage: "brain",
          description: Text("Memories your bot saves will appear here."))
      }
    }.navigationTitle("Memory").searchable(text: $query, prompt: "Search memories")
      .toolbar {
        Button("Clear all", role: .destructive) { clear = true }
          .disabled(loading || busy || value["memories"].array.isEmpty)
      }.task { await load() }.refreshable { await load() }
      .confirmationDialog(
        "Delete this memory?",
        isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
        titleVisibility: .visible
      ) {
        Button("Delete memory", role: .destructive) {
          guard let item = deleting else { return }
          Task { await remove(path + "/" + API.segment(item["id"].string)) }
        }
      } message: {
        Text("This removes the memory from the bot. This cannot be undone.")
      }
      .confirmationDialog("Clear all memories?", isPresented: $clear, titleVisibility: .visible) {
        Button("Clear all memories", role: .destructive) { Task { await remove(path) } }
      } message: {
        Text(
          "This removes all saved memories belonging to \(bot.name). Shared project memories are kept."
        )
      }
  }
  private func load() async {
    loading = true
    defer { loading = false }
    do {
      value = try await store.api?.request(path) ?? .null
      failure = nil
    } catch {
      failure = UserFacingError.message(error)
      if (error as? APIError)?.unauthorized == true { store.handle(error) }
    }
  }
  private func remove(_ target: String) async {
    busy = true
    defer {
      busy = false
      deleting = nil
    }
    do {
      value = try await store.api?.request(target, method: "DELETE") ?? value
      failure = nil
    } catch {
      failure = UserFacingError.message(error)
      if (error as? APIError)?.unauthorized == true { store.handle(error) }
    }
  }
}
