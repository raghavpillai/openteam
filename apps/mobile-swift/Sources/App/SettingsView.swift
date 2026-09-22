import SwiftUI

struct SettingsView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @AppStorage("appearance") private var appearance = "system"
  @AppStorage("accent") private var accent = "black"
  @AppStorage("haptics") private var haptics = true
  @State private var signOut = false
  var body: some View {
    NavigationStack {
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
            }.padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
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
            }.padding(.vertical, 5).frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
          }.accessibilityIdentifier("plugins-settings")
        }
        Section("Bot") {
          NavigationLink("Bot notifications") { notificationSettings }
          NavigationLink("Hidden conversations") { HiddenConversationsView() }
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
          ShareLink(
            item: "OpenTeam feedback\nVersion \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")\niOS \(UIDevice.current.systemVersion)"
          ) { Text("Send Feedback") }
        }
        Section {
          NavigationLink("Server status") { ServerStatusView() }
          Button(store.requiresAuthentication ? "Sign out" : "Disconnect", role: .destructive) {
            signOut = true
          }.disabled(store.busy.contains("sign-out")).accessibilityIdentifier("sign-out")
        }
      }.listStyle(.insetGrouped)
        .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button { dismiss() } label: {
              Image(systemName: "xmark").foregroundStyle(.primary)
            }.accessibilityLabel("Close")
              .accessibilityIdentifier("sheet-close")
          }
        }
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
struct ServerStatusView: View {
  @Environment(AppStore.self) private var store
  var body: some View {
    NativeForm {
      Section("Services") {
        ForEach((store.state.bootstrap?.runtime.object ?? [:]).keys.sorted(), id: \.self) { key in
          LabeledContent(
            key.capitalized, value: store.state.bootstrap?.runtime[key].string ?? "Unknown")
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
  @State private var changingNotifications = false
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
                BotGlyph(color: Color(hex: color), kind: icon, size: 80)
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
          if let bot {
            Section {
              Toggle(
                "Notifications",
                isOn: Binding(
                  get: { self.bot?.notificationsEnabled ?? false },
                  set: { enabled in
                    Task {
                      guard !changingNotifications else { return }
                      changingNotifications = true
                      defer { changingNotifications = false }
                      NativeHaptics.play(.selection, source: "profile.notifications")
                      await store.mutate(
                        "/api/v0/bots/\(API.segment(bot.id))", method: "PATCH",
                        body: .object(["notificationsEnabled": .bool(enabled)]))
                    }
                  })
              ).frame(minHeight: 28).disabled(changingNotifications).accessibilityIdentifier("profile-notifications")
            } footer: {
              Text("Get notified when this Bot finishes or needs input")
                .font(.system(size: 14)).foregroundStyle(NativePalette.faint)
                .listRowInsets(EdgeInsets(top: 8, leading: 18, bottom: 8, trailing: 18))
            }
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
      }.listSectionSpacing(16)
        .contentMargins(.horizontal, 24, for: .scrollContent)
        .environment(\.defaultMinListRowHeight, 50)
        .navigationTitle("Details").navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .navigationBarBackButtonHidden()
        .background(NativeBackGesture().frame(width: 0, height: 0))
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
              dismiss()
            } label: {
              Image(systemName: "chevron.left").foregroundStyle(NativePalette.text)
            }.accessibilityLabel("Done").accessibilityIdentifier("profile-back")
          }
          ToolbarItem(placement: .topBarTrailing) {
            if profileChanged {
              Button(saving ? "Saving…" : "Save") { Task { await save() } }.disabled(
                saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                  || (channel?.isGroup == true && name.count > 80) || title.count > 120
                  || description.count > 2_000 || instructions.count > 20_000
                  || (channel?.isGroup == true && (members.isEmpty || members.count > 6))
              )
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
            .accessibilityLabel("Bot options").accessibilityIdentifier("profile-options")
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
    guard let channel else { return }
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
