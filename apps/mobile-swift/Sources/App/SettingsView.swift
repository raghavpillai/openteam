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
      VStack(spacing: 0) {
        SheetHeading { dismiss() }
        ScrollView {
          VStack(spacing: 28) {
            NavigationLink {
              AccountConnectionView().toolbar(.visible, for: .navigationBar)
            } label: {
              HStack(spacing: 10) {
                AccountMark(name: store.accountDisplayName)
                VStack(alignment: .leading, spacing: 2) {
                  Text(store.accountDisplayName).font(.body)
                  Text(store.server).font(.system(size: 13)).foregroundStyle(NativePalette.muted)
                    .lineLimit(1)
                  Text("Self-hosted").font(.system(size: 12)).foregroundStyle(NativePalette.muted)
                }
                Spacer(minLength: 0)
                chevron
              }.padding(16).frame(minHeight: 86)
            }.accessibilityIdentifier("account-settings").buttonStyle(.plain).background(
              NativePalette.surface, in: RoundedRectangle(cornerRadius: 12))
            NavigationLink {
              PluginListView().toolbar(.visible, for: .navigationBar)
            } label: {
              HStack {
                VStack(alignment: .leading, spacing: 3) {
                  Text("Plugins").font(.body)
                  Text("Tools and skills for OpenTeam").font(.system(size: 13)).foregroundStyle(
                    NativePalette.muted)
                }
                Spacer()
                chevron
              }.padding(16)
            }.buttonStyle(.plain).background(
              NativePalette.surface, in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 8) {
              Text("Bot").font(.system(size: 13)).foregroundStyle(NativePalette.faint).padding(
                .leading, 16)
              VStack(spacing: 0) {
                NavigationLink {
                  notificationSettings.toolbar(.visible, for: .navigationBar)
                } label: {
                  row("Bot notifications") { chevron }
                }.buttonStyle(.plain)
                separator
                NavigationLink {
                  HiddenConversationsView().toolbar(.visible, for: .navigationBar)
                } label: {
                  row("Hidden conversations") { chevron }
                }.buttonStyle(.plain)
              }.background(NativePalette.surface, in: RoundedRectangle(cornerRadius: 12))
            }
            PushNotificationSettings()
            VStack(spacing: 0) {
              Menu {
                Picker("Appearance", selection: $appearance.hapticSelection("settings.appearance"))
                {
                  Text("System").tag("system")
                  Text("Light").tag("light")
                  Text("Dark").tag("dark")
                }
                Picker("Accent", selection: $accent.hapticSelection("settings.accent")) {
                  Text("Black").tag("black")
                  Text("Blue").tag("blue")
                }
              } label: {
                row("Appearance") {
                  Text(
                    (appearance == "system" ? "System" : appearance == "dark" ? "Night" : "Day")
                      + " · " + accent.capitalized
                  ).foregroundStyle(NativePalette.muted)
                  chevron
                }
              }.accessibilityIdentifier("appearance-picker")
              separator
              Toggle("App haptics", isOn: $haptics).font(.body).tint(NativePalette.toggle).padding(
                .horizontal, 16
              ).frame(minHeight: 50)
            }.background(NativePalette.surface, in: RoundedRectangle(cornerRadius: 12))
            VStack(spacing: 0) {
              NavigationLink {
                NativePreferencesView().toolbar(.visible, for: .navigationBar)
              } label: {
                row("More preferences") { chevron }
              }.buttonStyle(.plain)
              separator
              Link(destination: URL(string: "https://github.com/raghavpillai/openteam#readme")!) {
                row("Help Center") { Image(systemName: "arrow.up.right") }
              }
              separator
              ShareLink(
                item:
                  "OpenTeam feedback\nVersion \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")\niOS \(UIDevice.current.systemVersion)"
              ) {
                row("Send Feedback") { Image(systemName: "square.and.arrow.up") }
              }
            }.background(NativePalette.surface, in: RoundedRectangle(cornerRadius: 12))
            VStack(spacing: 0) {
              NavigationLink {
                ServerStatusView().toolbar(.visible, for: .navigationBar)
              } label: {
                row("Server status") { chevron }
              }.buttonStyle(.plain)
              separator
              Button {
                signOut = true
              } label: {
                row(store.requiresAuthentication ? "Sign out" : "Disconnect") { EmptyView() }
                  .foregroundStyle(NativePalette.destructive)
              }.buttonStyle(.plain).disabled(store.busy.contains("sign-out"))
                .accessibilityIdentifier("sign-out")
            }.background(NativePalette.surface, in: RoundedRectangle(cornerRadius: 12))
          }.padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 24)
        }
      }.background(NativePalette.background).toolbar(.hidden, for: .navigationBar)
        .preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
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
  }
  var chevron: some View {
    Image(systemName: "chevron.right").font(.system(size: 12, weight: .medium)).foregroundStyle(
      NativePalette.faint)
  }
  var separator: some View { NativePalette.separator.frame(height: 0.5).padding(.leading, 16) }
  func row<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    HStack(spacing: 8) {
      Text(title)
      Spacer()
      content()
    }.font(.body).padding(.horizontal, 16).frame(minHeight: 50).contentShape(Rectangle())
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
  private var routinePath: String {
    "/api/v0/\(channel?.isGroup == true ? "channels" : "bots")/\(API.segment(bot?.id ?? channelID))/routines"
  }
  var channel: Channel? { store.channel(channelID) }
  var bot: Bot? { channel.flatMap { store.bot(for: $0) } }
  var body: some View {
    Group {
      NativeForm {
        if let channel {
          Section {
            HStack {
              Spacer()
              if bot != nil {
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
              }
              .foregroundStyle(NativePalette.link)
            } header: {
              Text("Character").font(.footnote).foregroundStyle(NativePalette.faint)
            } footer: {
              Text(
                bot?.hasAvatar == true
                  ? "Changing the robot replaces the current custom photo."
                  : "How this Bot’s mark looks everywhere"
              ).foregroundStyle(NativePalette.faint)
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
                Label("Instructions", systemImage: "doc.text")
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
          Section {
            Button(
              store.isHidden(channel) ? "Show in conversations" : "Hide conversation",
              systemImage: "eye.slash"
            ) { Task { await store.hide(channel, hidden: !store.isHidden(channel)) } }
            Button(store.pins.contains(channel.id) ? "Unpin" : "Pin", systemImage: "pin") {
              Task { await store.togglePin(channel.id) }
            }
          }
          Section {
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
              }
              if bot.status == "failed" {
                Button("Retry setup") {
                  Task { await store.mutate("/api/v0/bots/\(API.segment(bot.id))/retry") }
                }
              }
            }
            Button(channel.isGroup ? "Delete group" : "Delete bot", role: .destructive) {
              deleting = true
            }
          }
        }
      }.navigationTitle("Details").navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .navigationBarBackButtonHidden()
        .background(NativeBackGesture().frame(width: 0, height: 0))
        .scrollContentBackground(.hidden).background(NativePalette.background)
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
            Button("Done", systemImage: "chevron.left") { dismiss() }.labelStyle(.iconOnly)
          }
          ToolbarItem(placement: .confirmationAction) {
            Button(saving ? "Saving…" : "Save") { Task { await save() } }.disabled(
              saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || (channel?.isGroup == true && name.count > 80) || title.count > 120
                || description.count > 2_000 || instructions.count > 20_000
                || (channel?.isGroup == true && (members.isEmpty || members.count > 6))
            )
            .accessibilityIdentifier("profile-save")
          }
        }
        .sheet(isPresented: $addingRoutine, onDismiss: { routineRefreshID += 1 }) {
          RoutineEditor(ownerPath: routinePath, routine: nil)
        }
        .sheet(item: $editingRoutine, onDismiss: { routineRefreshID += 1 }) { routine in
          RoutineEditor(ownerPath: routinePath, routine: routine)
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
      if icon != bot.icon || color.lowercased() != bot.color.lowercased() {
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
      if await store.mutate(
        "/api/v0/channels/\(API.segment(channel.id))/members", method: "PUT",
        body: .object([
          "botIds": .array(members.sorted().map(JSON.string)),
          "clientId": .string(UUID().uuidString),
        ])) != nil
      {
        NativeHaptics.play(.success, source: "profile.save")
        dismiss()
      }
    }
  }
}
