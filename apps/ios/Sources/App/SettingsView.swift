import SwiftUI

/// Settings pages that other screens open directly.
enum SettingsRoute: Hashable { case model, voiceNotes }

struct SettingsView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @AppStorage("appearance") private var appearance = "system"
  @AppStorage("accent") private var accent = "black"
  @AppStorage("haptics") private var haptics = true
  @State private var signOut = false
  @State private var verticalBar = false
  @State private var path: [SettingsRoute]
  init(initialRoute: SettingsRoute? = nil) {
    _path = State(initialValue: initialRoute.map { [$0] } ?? [])
  }
  var body: some View {
    NavigationStack(path: $path) {
      NativeList {
        Section {
          NavigationLink {
            AccountConnectionView()
          } label: {
            HStack(spacing: 10) {
              AccountMark(name: store.accountDisplayName)
              VStack(alignment: .leading, spacing: 2) {
                Text(store.accountDisplayName).font(.body)
                Text(store.server).font(.system(size: 13)).foregroundStyle(NativePalette.muted)
                  .lineLimit(1)
                Text("Self-hosted").font(.system(size: 12)).foregroundStyle(NativePalette.muted)
              }
            }.padding(.vertical, 4).frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
          }.accessibilityIdentifier("account-settings")
        }
        Section {
          NavigationLink {
            PluginListView()
          } label: {
            VStack(alignment: .leading, spacing: 3) {
              Text("Plugins").font(.body)
              Text("Tools and skills for OpenTeam").font(.system(size: 13))
                .foregroundStyle(NativePalette.muted)
            }.padding(.vertical, 1).frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
          }.accessibilityIdentifier("plugins-settings")
        }
        Section {
          NavigationLink(value: SettingsRoute.model) {
            serverRow(
              "Model", detail: "AI provider and model for all bots",
              status: modelStatus)
          }.accessibilityIdentifier("model-settings")
          NavigationLink(value: SettingsRoute.voiceNotes) {
            serverRow(
              "Voice notes", detail: "Transcription for recorded messages", status: voiceStatus)
          }.accessibilityIdentifier("voice-settings")
          NavigationLink {
            ProvidersSettingsView()
          } label: {
            VStack(alignment: .leading, spacing: 3) {
              Text("Providers").font(.body)
              Text("Web search and page fetching").font(.system(size: 13))
                .foregroundStyle(NativePalette.muted)
            }.padding(.vertical, 1).frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
          }.accessibilityIdentifier("providers-settings")
        } header: {
          Text("Server").font(.system(size: 13)).foregroundStyle(NativePalette.faint)
        }
        Section {
          NavigationLink("Bot notifications") { notificationSettings }
          NavigationLink("Hidden conversations") { HiddenConversationsView() }
        } header: {
          Text("Bot").font(.system(size: 13)).foregroundStyle(NativePalette.faint)
        }
        Section { PushNotificationSettings() }
        Section {
          Menu {
            Picker("Appearance", selection: $appearance.hapticSelection("settings.appearance")) {
              Text("System").tag("system")
              Text("Light").tag("light")
              Text("Dark").tag("dark")
            }
            Picker("Accent", selection: $accent.hapticSelection("settings.accent")) {
              Text("Black").tag("black")
              Text("Blue").tag("blue")
            }
          } label: {
            LabeledContent(
              "Appearance",
              value: (appearance == "system" ? "System" : appearance == "dark" ? "Night" : "Day")
                + " · " + accent.capitalized
            ).frame(maxWidth: .infinity).contentShape(Rectangle())
          }.accessibilityIdentifier("appearance-picker").foregroundStyle(NativePalette.text)
          Toggle("App haptics", isOn: $haptics).tint(NativePalette.toggle)
        }
        Section {
          NavigationLink("More preferences") { NativePreferencesView() }
          Link("Help Center", destination: URL(string: "https://github.com/raghavpillai/openteam#readme")!)
        }
        Section {
          NavigationLink("Manage devices") { ManageDevicesView() }
          NavigationLink("Server status") { ServerStatusView() }
          Button(store.requiresAuthentication ? "Sign out" : "Disconnect", role: .destructive) {
            signOut = true
          }.disabled(store.busy.contains("sign-out")).accessibilityIdentifier("sign-out")
        }
      }.listStyle(.insetGrouped)
        // The reference's cards begin 16 points inside the inset sheet, with
        // less top/row padding than the system's default grouped list.
        .listCardMargins(16)
        .contentMargins(.top, 20, for: .scrollContent)
        .listSectionSpacing(28)
        .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: SettingsRoute.self) { route in
          switch route {
          case .model: ModelSettingsView()
          case .voiceNotes: VoiceNotesSettingsView()
          }
        }
        .toolbar {
          // With Close in iPhone Duo's side bar, the title fills the top bar
          // as on every settings page; elsewhere the sheet keeps it hidden.
          if !verticalBar {
            ToolbarItem(placement: .principal) { Color.clear.frame(width: 1, height: 1) }
          }
          ToolbarItem(placement: .cancellationAction) {
            Button { dismiss() } label: {
              Image(systemName: "xmark").foregroundStyle(.primary)
            }.accessibilityLabel("Close")
              .accessibilityIdentifier("sheet-close")
          }
        }
        .readingVerticalBar($verticalBar)
        .confirmationDialog(
          "Sign out of this server?", isPresented: $signOut, titleVisibility: .visible
        ) {
          Button("Sign out", role: .destructive) {
            Task {
              await store.signOut()
              if store.phase == .signedOut { dismiss() }
            }
          }
        } message: {
          Text(
            store.state.outbox.isEmpty
              ? "Saved conversations and drafts will be removed from this iPhone."
              : "There are unsent messages. Signing out removes them and your drafts from this iPhone."
          )
        }
    }
    .preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
  }
  /// The Model row's warning while bots can't reply.
  private var modelStatus: (text: String, warning: Bool)? {
    switch store.runtime.inference {
    case "missing": return ("Not connected", true)
    case "invalid": return ("Not working", true)
    case "unavailable": return ("Unavailable", true)
    default: return nil
    }
  }
  private var voiceStatus: (text: String, warning: Bool)? {
    store.runtime.values["transcription"].map { ($0 == "configured" ? "On" : "Off", false) }
  }
  private func serverRow(
    _ title: String, detail: String, status: (text: String, warning: Bool)?
  ) -> some View {
    HStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(.body)
        Text(detail).font(.system(size: 13)).foregroundStyle(NativePalette.muted)
      }
      Spacer(minLength: 8)
      if let status {
        Text(status.text).font(.subheadline)
          .foregroundStyle(status.warning ? NativePalette.warning : NativePalette.muted)
      }
    }.padding(.vertical, 1).frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
  }
  var notificationSettings: some View {
    NativeList {
      ForEach(store.bots) { bot in
        Toggle(
          bot.name,
          isOn: Binding(
            get: { store.bots.first { $0.id == bot.id }?.notificationsEnabled ?? false },
            set: { value in
              Task {
                await store.mutate(
                  "/api/v0/bots/\(API.segment(bot.id))", method: "PATCH",
                  body: .object(["notificationsEnabled": .bool(value)]))
              }
            })
        ).tint(NativePalette.toggle)
      }
    }.navigationTitle("Bot notifications")
  }
}
struct HiddenConversationsView: View {
  @Environment(AppStore.self) private var store
  var body: some View {
    NativeList {
      if store.channels.filter(store.isHidden).isEmpty {
        ContentUnavailableView(
          "No hidden conversations", systemImage: "eye.slash",
          description: Text("Conversations you hide appear here."))
      }
      ForEach(store.channels.filter(store.isHidden)) { channel in
        HStack {
          ChannelAvatar(channel: channel, size: 36)
          Text(channel.name)
          Spacer()
          Button("Show") { Task { await store.hide(channel, hidden: false) } }
        }
      }
    }.navigationTitle("Hidden conversations")
  }
}
/// One computer: its name, a status dot, and "Computer · Online now · Messages on".
struct ManagedDeviceRow: View {
  let machine: JSON
  private static let messagesLabels = ["ready": "Messages on", "needs_permission": "Messages needs permissions", "off": "Messages off"]
  var body: some View {
    let online = machine["enabled"].bool && machine["connected"].bool
    let status: String = !machine["enabled"].bool ? "Disabled" : online ? "Online now" : ManageDevicesView.lastOpened(machine["lastSeenAt"].string)
    let messages: String = Self.messagesLabels[machine["messages"].string].map { " · " + $0 } ?? ""
    HStack(spacing: 12) {
      Image(systemName: "desktopcomputer").foregroundStyle(NativePalette.muted)
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: machine["label"].string)
        // The dot is part of the text so it stays beside the first line when the status wraps.
        (Text(Image(systemName: "circle.fill")).font(.system(size: 6)).foregroundStyle(online ? Color.green : Color.gray.opacity(0.5))
          + Text(verbatim: "  Computer · " + status + messages).font(.footnote).foregroundStyle(NativePalette.muted))
      }
    }
  }
}

/// The computers connected to this server: online now or when last opened, and whether Messages is on.
struct ManageDevicesView: View {
  @Environment(AppStore.self) private var store
  @State private var machines: [JSON] = []
  @State private var failure: String?
  @State private var busy = false
  static func lastOpened(_ value: String, now: Date = Date()) -> String {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = parser.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return "Not opened yet" }
    return "Last opened " + RelativeDateTimeFormatter().localizedString(for: date, relativeTo: now)
  }
  private func load() async {
    do {
      machines = try await store.request("/api/v0/server-settings/machines").array
        .sorted { ($0["connected"].bool ? 0 : 1) < ($1["connected"].bool ? 0 : 1) }
      failure = nil
    } catch is CancellationError {
    } catch {
      failure = UserFacingError.message(error)
    }
  }
  private func change(_ machine: JSON, _ method: String, _ body: JSON? = nil) {
    busy = true
    Task {
      defer { busy = false }
      do {
        _ = try await store.request("/api/v0/server-settings/machines/\(API.segment(machine["machineId"].string))", method: method, body: body)
        await load()
      } catch {
        failure = UserFacingError.message(error)
      }
    }
  }
  var body: some View {
    NativeForm {
      if let failure { InlineFailure(message: failure) }
      Section {
        if machines.isEmpty {
          Text("Open the OpenTeam desktop app on a computer and sign in to add it here.")
            .font(.subheadline).foregroundStyle(NativePalette.muted)
        }
        ForEach(machines.indices, id: \.self) { index in
          let machine = machines[index]
          ManagedDeviceRow(machine: machine)
            .swipeActions {
              Button("Remove", role: .destructive) { change(machine, "DELETE") }.disabled(busy)
              if machine["transport"].string == "relay" {
                Button(machine["enabled"].bool ? "Disable" : "Enable") {
                  change(machine, "PATCH", .object(["enabled": .bool(!machine["enabled"].bool)]))
                }.disabled(busy)
              }
            }
        }
      } footer: {
        Text("Turn on Messages in the desktop app on each Mac, under Settings → Computer.")
      }
    }
    .navigationTitle("Manage devices")
    .task { await load() }
    .refreshable { await load() }
  }
}

struct ServerStatusView: View {
  @Environment(AppStore.self) private var store
  var body: some View {
    NativeForm {
      ServerActivitySection()
      Section("Services") {
        ForEach(store.runtime.statusRows, id: \.label) { row in
          LabeledContent(row.label, value: row.value)
        }
      }
      Button("Refresh") { Task { await store.refresh() } }
    }.navigationTitle("Server status")
  }
}

struct ConversationDetails: View {
  private enum ProfileField: Hashable { case name, title, description, instructions }
  @FocusState private var focusedProfile: ProfileField?
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  let channelID: String
  var onDuplicate: (String) -> Void = { _ in }
  @State private var name = ""
  @State private var description = ""
  @State private var instructions = ""
  @State private var members: Set<String> = []
  @State private var resetAvatar = false
  @State private var deleting = false
  @State private var saving = false
  @State private var duplicateID = UUID().uuidString
  @State private var color = "#A47952"
  @State private var icon = "chip"
  @State private var title = ""
  @State private var initialized = false
  @State private var duplicating = false
  @State private var failure: String?
  @State private var addingRoutine = false
  @State private var editingRoutine: Routine?
  @State private var routineRefreshID = 0
  @State private var templateFile: URL?
  @State private var exportingTemplate = false
  @State private var confirmingExit = false
  private var routinePath: String {
    "/api/v0/\(channel?.isGroup == true ? "channels" : "bots")/\(API.segment(bot?.id ?? channelID))/routines"
  }
  var channel: Channel? { store.channel(channelID) }
  var bot: Bot? { channel.flatMap { store.bot(for: $0) } }
  var body: some View {
    Group {
      NativeForm(rowInsets: EdgeInsets(top: 14, leading: 18, bottom: 14, trailing: 18)) {
        if let channel {
          Section {
            HStack {
              Spacer()
              if let bot, !bot.hasAvatar || resetAvatar || icon != bot.icon
                || color.lowercased() != bot.color.lowercased() {
                BotGlyph(color: Color(hex: color), kind: icon, size: 80, mode: .idle)
              } else {
                ChannelAvatar(channel: channel, size: 80)
              }
              Spacer()
            }.listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
          }
          if let failure { Section { InlineFailure(message: failure) } }
          Section {
            TextField("Name", text: $name).accessibilityIdentifier("profile-name")
              .focused($focusedProfile, equals: .name)
              .font(.title3.weight(.semibold)).multilineTextAlignment(.center)
            if bot != nil {
              TextField("Title (optional)", text: $title).accessibilityIdentifier("profile-title")
                .focused($focusedProfile, equals: .title).multilineTextAlignment(.center)
            } else {
              TextField("Description", text: $description, axis: .vertical).lineLimit(2...5)
                .accessibilityIdentifier("profile-description").focused(
                  $focusedProfile, equals: .description)
            }
          }.listRowBackground(NativePalette.assistant)
          if bot != nil {
            Section {
              RobotIdentityPicker(icon: $icon, color: $color, showsPreview: false)
              Button("Reset to default") {
                icon = "classic"
                color = "#A47952"
                resetAvatar = true
              }
              .foregroundStyle(NativePalette.link)
            } header: {
              Text("Character").font(.footnote).foregroundStyle(NativePalette.faint)
            } footer: {
              Text(
                bot?.hasAvatar == true
                  ? "Changing the robot replaces the current custom photo."
                  : "How this Bot’s mark looks everywhere"
              ).font(.system(size: 14)).foregroundStyle(NativePalette.faint)
                .listRowInsets(EdgeInsets(top: 8, leading: 18, bottom: 8, trailing: 18))
            }.listRowBackground(NativePalette.assistant)
            Section {
              NavigationLink {
                NativeForm {
                  Section("Description") {
                    TextField("Description", text: $description, axis: .vertical).lineLimit(2...5)
                      .accessibilityIdentifier("profile-description")
                  }
                  Section("Instructions") {
                    TextEditor(text: $instructions).frame(minHeight: 220)
                      .accessibilityIdentifier("profile-instructions")
                  }
                }.navigationTitle("Instructions").navigationBarTitleDisplayMode(.inline)
                  .scrollDismissesKeyboard(.interactively)
              } label: {
                HStack(spacing: 14) {
                  Image(systemName: "doc.text").font(.system(size: 17))
                    .foregroundStyle(NativePalette.muted).frame(width: 20)
                  Text("Instructions")
                }
              }
            }.listRowBackground(NativePalette.assistant)
          }
          if channel.isGroup {
            Section("Members") {
              ForEach(store.bots) { bot in
                Toggle(
                  bot.name,
                  isOn: Binding(
                    get: { members.contains(bot.id) },
                    set: { enabled in
                      guard enabled != members.contains(bot.id), !enabled || members.count < 6
                      else { return }
                      NativeHaptics.play(.selection, source: "group.member")
                      if enabled { members.insert(bot.id) } else { members.remove(bot.id) }
                    }))
              }
            }
          }
          ProfileRoutinesView(
            ownerID: bot?.id ?? channel.id, isGroup: channel.isGroup,
            refreshID: routineRefreshID, onAdd: { addingRoutine = true },
            onEdit: { editingRoutine = $0 })
          if bot != nil {
            Section {
              Button {
                Task { await exportTemplate() }
              } label: {
                HStack(spacing: 14) {
                  Image(systemName: "square.and.arrow.up").font(.system(size: 17)).frame(width: 20)
                  Text(exportingTemplate ? "Preparing template…" : "Share as Template")
                }
              }.foregroundStyle(NativePalette.link).disabled(exportingTemplate)
                .accessibilityIdentifier("profile-share-template")
            }
          }
        }
      }.disabled(saving).listSectionSpacing(16)
        .listCardMargins(24)
        .environment(\.defaultMinListRowHeight, 50)
        .navigationTitle("Details").navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .navigationBarBackButtonHidden()
        .background(NativeBackGesture(shouldBegin: mayLeaveProfile).frame(width: 0, height: 0))
        .scrollContentBackground(.hidden).nativeCanvas()
        .toolbarBackground(.hidden, for: .navigationBar)
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
          ToolbarItem(placement: .principal) {
            Color.clear.frame(width: 1, height: 1).accessibilityHidden(true)
          }
          ToolbarItemGroup(placement: .keyboard) {
            Spacer()
            Button("Done") { focusedProfile = nil }.accessibilityLabel("Hide keyboard")
          }
          ToolbarItem(placement: .cancellationAction) {
            Button {
              if mayLeaveProfile() { dismiss() }
            } label: {
              Image(systemName: "chevron.left").foregroundStyle(NativePalette.text)
            }.disabled(saving).accessibilityLabel("Done").accessibilityIdentifier("profile-back")
          }
          ToolbarItem(placement: .topBarTrailing) {
            if profileChanged {
              Button(saving ? "Saving…" : "Save") { Task { await save() } }.disabled(!canSaveProfile)
              .accessibilityIdentifier("profile-save")
            } else if bot != nil {
              Button {
                Task { await exportTemplate() }
              } label: {
                Image(systemName: "square.and.arrow.up").foregroundStyle(NativePalette.text)
              }.disabled(exportingTemplate).accessibilityLabel("Share as Template")
            }
          }
          if #available(iOS 26, *) { ToolbarSpacer(.fixed, placement: .topBarTrailing) }
          ToolbarItem(placement: .topBarTrailing) {
            Menu {
              if let bot {
                Button("Duplicate bot", systemImage: "plus.square.on.square") {
                  Task {
                    guard !duplicating else { return }
                    duplicating = true
                    defer { duplicating = false }
                    if let result = await store.mutate(
                      "/api/v0/bots/\(API.segment(bot.id))/duplicate",
                      body: .object(["clientRequestId": .string(duplicateID)]))
                    {
                      onDuplicate(result["dmChannelId"].string)
                      dismiss()
                    }
                  }
                }.disabled(duplicating)
                if bot.status == "failed" {
                  Button("Retry setup") {
                    Task { await store.mutate("/api/v0/bots/\(API.segment(bot.id))/retry") }
                  }
                }
              }
              Button(channel?.isGroup == true ? "Delete group" : "Delete bot", role: .destructive) {
                deleting = true
              }
            } label: {
              Image(systemName: "ellipsis").foregroundStyle(NativePalette.text)
            }
            .disabled(saving).accessibilityLabel("Bot options").accessibilityIdentifier("profile-options")
          }
        }
        .sheet(
          isPresented: Binding(get: { templateFile != nil }, set: { if !$0 { templateFile = nil } })
        ) {
          if let templateFile {
            NativeFileShare(url: templateFile) { failure = UserFacingError.message($0) }
          }
        }
        .sheet(isPresented: $addingRoutine, onDismiss: { routineRefreshID += 1 }) {
          RoutineEditor(ownerPath: routinePath, routine: nil)
        }
        .sheet(item: $editingRoutine, onDismiss: { routineRefreshID += 1 }) { routine in
          RoutineEditor(ownerPath: routinePath, routine: routine)
        }
        .task(id: store.focusedRoutine) {
          guard let id = store.focusedRoutine else { return }
          do {
            let routines = try await store.fetch(routinePath, as: [Routine].self)
            guard let routine = routines.first(where: { $0.id == id }) else {
              throw APIError("This routine is no longer available.")
            }
            editingRoutine = routine
          } catch { failure = UserFacingError.message(error) }
          store.focusedRoutine = nil
        }
        .onAppear {
          guard !initialized else { return }
          initialized = true
          name = channel?.name ?? ""
          description = bot?.description ?? channel?.description ?? ""
          instructions = bot?.instructions ?? ""
          icon = bot?.icon ?? "chip"
          color = bot?.color ?? "#A47952"
          title = bot?.title ?? ""
          members = Set(channel?.members.map(\.botId) ?? [])
        }
        .alert("Save changes?", isPresented: $confirmingExit) {
          Button("Save changes") { Task { await save() } }.disabled(!canSaveProfile)
          Button("Discard changes", role: .destructive) { dismiss() }
          Button("Keep editing", role: .cancel) {}
        } message: {
          Text("Your profile changes haven’t been saved.")
        }
        .confirmationDialog(
          "Delete \(channel?.name ?? "conversation")?", isPresented: $deleting,
          titleVisibility: .visible
        ) {
          Button("Delete", role: .destructive) {
            Task {
              let path =
                bot.map { "/api/v0/bots/\(API.segment($0.id))" }
                ?? "/api/v0/channels/\(API.segment(channelID))"
              if await store.mutate(path, method: "DELETE") != nil {
                dismiss()
                store.navigation = []
              }
            }
          }
        } message: {
          Text("This removes the conversation and its history. This cannot be undone.")
        }
    }
  }
  private var profileChanged: Bool {
    initialized
      && (name != (channel?.name ?? "")
        || description != (bot?.description ?? channel?.description ?? "")
        || instructions != (bot?.instructions ?? "") || title != (bot?.title ?? "")
        || icon != (bot?.icon ?? "chip") || color != (bot?.color ?? "#A47952")
        || resetAvatar || members != Set(channel?.members.map(\.botId) ?? []))
  }
  private var canSaveProfile: Bool {
    !saving && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !(channel?.isGroup == true && name.count > 80) && title.count <= 120
      && description.count <= 2_000 && instructions.count <= 20_000
      && !(channel?.isGroup == true && (members.isEmpty || members.count > 6))
  }
  private func mayLeaveProfile() -> Bool {
    guard !saving else { return false }
    guard profileChanged else { return true }
    focusedProfile = nil
    confirmingExit = true
    return false
  }
  private func exportTemplate() async {
    guard let bot, !exportingTemplate else { return }
    exportingTemplate = true
    defer { exportingTemplate = false }
    do {
      let routines = try await store.fetch(routinePath, as: [Routine].self)
      let recipe = BotTemplateExport.recipe(bot: bot, routines: routines)
      let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let url = folder.appendingPathComponent("Bot Template.json")
      try JSONEncoder().encode(recipe).write(to: url, options: [.atomic, .completeFileProtection])
      NativeHaptics.play(.light, source: "profile.share-template")
      templateFile = url
    } catch { failure = UserFacingError.message(error) }
  }
  func save() async {
    guard canSaveProfile, let channel else { return }
    saving = true
    defer { saving = false }
    if let bot {
      var fields: [String: JSON] = [
        "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
        "description": .string(description), "instructions": .string(instructions),
        "title": .string(title),
      ]
      if resetAvatar || icon != bot.icon || color.lowercased() != bot.color.lowercased() {
        fields["icon"] = .string(icon)
        fields["color"] = .string(color)
      }
      if await store.mutate(
        "/api/v0/bots/\(API.segment(bot.id))", method: "PATCH",
        body: .object(fields)) != nil
      {
        NativeHaptics.play(.success, source: "profile.save")
        dismiss()
      }
    } else {
      guard
        await store.mutate(
          "/api/v0/channels/\(API.segment(channel.id))/profile", method: "PATCH",
          body: .object([
            "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
            "description": .string(description),
            "clientId": .string(UUID().uuidString),
          ])) != nil
      else { return }
      // A name/description edit must not rewrite membership or its ordinals.
      if members == Set(channel.members.map(\.botId)) {
        NativeHaptics.play(.success, source: "profile.save")
        dismiss()
        return
      }
      let ordered = channel.members.sorted { $0.ordinal < $1.ordinal }.map(\.botId)
        .filter { members.contains($0) }
      let additions = store.bots.map(\.id).filter { members.contains($0) && !ordered.contains($0) }
      if await store.mutate(
        "/api/v0/channels/\(API.segment(channel.id))/members", method: "PUT",
        body: .object([
          "botIds": .array((ordered + additions).map(JSON.string)),
          "clientId": .string(UUID().uuidString),
        ])) != nil
      {
        NativeHaptics.play(.success, source: "profile.save")
        dismiss()
      }
    }
  }
}
