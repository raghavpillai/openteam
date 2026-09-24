import SwiftUI

struct HomeView: View {
  @Environment(AppStore.self) private var store
  @State private var settings = false
  private enum CreationKind: String, Identifiable {
    case bot, group
    var id: Self { self }
  }
  @State private var creation: CreationKind?
  @State private var search = false
  @State private var pendingRoutine: String?
  @State private var pendingOpen: (channel: String, message: String?)?
  @State private var contentWidth: CGFloat = 390
  @State private var renamingSection: String?
  @State private var sectionName = ""
  @State private var deletingSection: JSON?
  private var visible: [Channel] { store.channels.filter { !store.isHidden($0) } }
  private var sections: [JSON] { store.sidebar["sections"].array }
  var body: some View {
    @Bindable var store = store
    NavigationStack(path: $store.navigation) {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          if !store.online && !store.syncingState {
            Label("Offline · messages will send when you reconnect", systemImage: "wifi.slash")
              .font(.footnote).foregroundStyle(NativePalette.muted).padding(.vertical, 8)
          }
          if !store.pins.isEmpty {
            ScrollView(.horizontal) {
              HStack(alignment: .top, spacing: 20) {
                ForEach(store.pins.compactMap { id in visible.first { $0.id == id } }) { channel in
                  NavigationLink(value: channel.id) {
                    VStack(spacing: 7) {
                      ChannelAvatar(channel: channel, size: 80)
                      Text(channel.name).font(.subheadline).foregroundStyle(NativePalette.muted)
                        .lineLimit(1)
                    }.frame(width: 100)
                  }.buttonStyle(.plain).accessibilityIdentifier("pinned-" + channel.id)
                    .contextMenu {
                      conversationActions(channel)
                    } preview: {
                      conversationPreview(channel)
                    }
                }
              }.padding(.vertical, 15)
            }.scrollIndicators(.hidden)
          }
          ForEach(sections, id: \.self) { section in
            sectionView(
              id: section["id"].string, name: section["name"].string,
              collapsed: section["collapsed"].bool)
          }
          sectionView(
            id: "", name: "Unassigned",
            collapsed: !sections.isEmpty && store.sidebar["unassignedCollapsed"].bool,
            showsHeading: !sections.isEmpty)
          if visible.isEmpty {
            Text("No conversations yet")
              .font(.subheadline).foregroundStyle(NativePalette.muted)
              .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
              .accessibilityIdentifier("empty-conversations")
          }
        }.padding(.horizontal, 20).padding(.bottom, 30)
      }.nativeCanvas().scrollIndicators(.hidden)
        .onGeometryChange(for: CGFloat.self) {
          $0.size.width
        } action: {
          contentWidth = $0
        }
        .scrollClipDisabled()
        .fadingTopBar { header }
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: String.self) { id in
          if let channel = store.channel(id) {
            ChatView(channel: channel)
          } else {
            ContentUnavailableView("Conversation unavailable", systemImage: "bubble.left")
          }
        }
        .refreshable { await store.refresh() }
        .sheet(isPresented: $settings) { SettingsView().referenceSheet() }
        .alert(
          "Rename section",
          isPresented: Binding(
            get: { renamingSection != nil }, set: { if !$0 { renamingSection = nil } }
          )
        ) {
          TextField("Section name", text: $sectionName)
          Button("Cancel", role: .cancel) { renamingSection = nil }
          Button("Save") {
            guard let id = renamingSection else { return }
            let name = sectionName.trimmingCharacters(in: .whitespacesAndNewlines)
            Task { await renameSection(id, name: name) }
          }.disabled(
            sectionName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              || sectionName.count > 120)
        }
        .confirmationDialog(
          "Delete section?",
          isPresented: Binding(
            get: { deletingSection != nil }, set: { if !$0 { deletingSection = nil } }
          ), titleVisibility: .visible
        ) {
          Button("Delete section", role: .destructive) {
            guard let section = deletingSection else { return }
            Task { await deleteSection(section["id"].string) }
          }
        } message: {
          Text("Its conversations will stay in your list.")
        }
        .sheet(item: $creation, onDismiss: openSelectedConversation) { kind in
          CreateConversationView(group: kind == .group) { id in
            pendingOpen = (id, nil)
            creation = nil
          }.referenceSheet()
            // Group search focuses immediately. Start at the keyboard's final
            // sheet detent so its first member tap cannot land on a moving row.
            .presentationDetents(kind == .group ? [.large] : [.fraction(0.95), .large])
        }
        .sheet(isPresented: $search, onDismiss: openSelectedConversation) {
          SearchView { id, message, routine in
            pendingRoutine = routine
            pendingOpen = (id, message)
            search = false
          }.referenceSheet()
        }
    }
  }
  func openSelectedConversation() {
    guard let target = pendingOpen else { return }
    pendingOpen = nil
    let routine = pendingRoutine
    pendingRoutine = nil
    Task {
      store.focusedRoutine = routine
      await store.open(target.channel, messageID: target.message)
    }
  }
  var header: some View {
    HStack(spacing: 4) {
      Button {
        settings = true
      } label: {
        AccountMark(name: store.userName).padding(3).nativeGlass()
      }
      .buttonStyle(.plain).accessibilityLabel("Settings").accessibilityIdentifier("settings-button")
      if store.syncingState {
        HStack(spacing: 8) {
          ProgressView().controlSize(.regular).tint(NativePalette.muted)
            .scaleEffect(0.8)
            .frame(width: 16, height: 16).accessibilityHidden(true)
          Text("Syncing state").font(.body.weight(.semibold)).lineLimit(1)
        }
        .padding(.leading, 12)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("syncing-state")
      }
      Spacer()
      ChromeButton(title: "Search", symbol: "magnifyingglass") { search = true }
        .accessibilityIdentifier("search-button")
      NativeActionMenu(symbol: "plus", pointSize: 20, title: "New conversation",
        identifier: "new-button", panelIdentifier: "creation-menu-panel",
        hapticSource: "home.create", systemMenu: true, actions: [
          .init(title: "New Bot", action: { if !store.syncingState { creation = .bot } }),
          .init(title: "New Group Chat", action: { if !store.syncingState { creation = .group } }),
        ]).frame(width: 44, height: 44).nativeGlass()
        .disabled(store.syncingState)
    }.foregroundStyle(NativePalette.text).padding(.horizontal, 18).padding(.top, 6).padding(
      .bottom, 10
    )
  }
  func sectionView(id: String, name: String, collapsed: Bool, showsHeading: Bool = true)
    -> some View
  {
    let validIDs = Set(sections.map { $0["id"].string })
    let rows = visible.filter {
      let assigned = store.sidebar["sectionByChannel"][$0.id].string
      return !store.pins.contains($0.id)
        && (id.isEmpty ? !validIDs.contains(assigned) : assigned == id)
    }
    let order = store.sidebar["channelOrderByGroup"][id.isEmpty ? "unassigned" : id].array.map(
      \.string)
    let sorted = rows.sorted { a, b in
      if let ai = order.firstIndex(of: a.id) { return ai < (order.firstIndex(of: b.id) ?? Int.max) }
      if order.contains(b.id) { return false }
      return a.updatedAt > b.updatedAt
    }
    return VStack(alignment: .leading, spacing: 0) {
      if showsHeading {
        Button {
          Task { await toggleSection(id) }
        } label: {
          HStack(spacing: 7) {
            Text(collapsed ? "\(name) \(rows.count)" : name).font(.system(size: 14))
            Image(systemName: collapsed ? "chevron.right" : "chevron.down").font(
              .system(size: 11, weight: .medium)
            ).foregroundStyle(NativePalette.faint)
          }.foregroundStyle(NativePalette.faint).padding(.top, 22).frame(height: 46)
            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel(name + " section")
          .accessibilityIdentifier("section-" + (id.isEmpty ? "unassigned" : id))
          .contextMenu {
            Button(
              collapsed ? "Expand" : "Collapse",
              systemImage: collapsed ? "chevron.down" : "chevron.up"
            ) {
              Task { await toggleSection(id) }
            }
            if !id.isEmpty {
              Button("Rename", systemImage: "pencil") {
                sectionName = name
                renamingSection = id
              }
              Button("Delete section", systemImage: "trash", role: .destructive) {
                deletingSection = sections.first { $0["id"].string == id }
              }
            }
          }
      }
      if !collapsed {
        if sorted.isEmpty, !id.isEmpty {
          Text("No chats").font(.system(size: 15)).foregroundStyle(NativePalette.faint)
            .frame(height: 28, alignment: .topLeading).padding(.top, 14)
        }
        ForEach(sorted) { channel in
          ConversationSwipeRow(
            pinned: store.pins.contains(channel.id),
            pin: { Task { await store.togglePin(channel.id) } },
            hide: { Task { await store.hide(channel, hidden: true) } }
          ) {
            NavigationLink(value: channel.id) { ChannelRow(channel: channel) }.buttonStyle(.plain)
              .accessibilityIdentifier("channel-" + channel.id)
              .contextMenu {
                conversationActions(channel)
              } preview: {
                conversationPreview(channel)
              }
          }
        }
      }
    }
  }
  @ViewBuilder private func conversationActions(_ channel: Channel) -> some View {
    Button("Mark unread", systemImage: "bubble.left") {
      Task { await markUnread(channel.id) }
    }
    Button(store.pins.contains(channel.id) ? "Unpin" : "Pin", systemImage: "pin") {
      Task { await store.togglePin(channel.id) }
    }
    Menu("Move to", systemImage: "folder") {
      Button("Unassigned") { Task { await move(channel.id, to: "") } }
      ForEach(sections, id: \.self) { section in
        Button(section["name"].string) {
          Task { await move(channel.id, to: section["id"].string) }
        }
      }
    }
    Button("Hide", systemImage: "eye.slash") {
      Task { await store.hide(channel, hidden: true) }
    }
  }
  private func conversationPreview(_ channel: Channel) -> some View {
    ChannelRow(channel: channel).padding(.horizontal, 18)
      .frame(width: max(100, contentWidth - 40))
      .background(NativePalette.background, in: RoundedRectangle(cornerRadius: 12))
      .environment(store)
      .onAppear { NativeHaptics.play(.medium, source: "conversation.long-press") }
  }
  func saveSidebar(_ next: JSON) async {
    if let value = await store.mutate("/api/v0/settings/sidebar", method: "PATCH", body: next) {
      store.sidebar = value
    }
  }
  func renameSection(_ id: String, name: String) async {
    guard !name.isEmpty, name.count <= 120 else { return }
    var next = store.sidebar
    var values = next["sections"].array
    guard let index = values.firstIndex(where: { $0["id"].string == id }) else { return }
    values[index]["name"] = .string(name)
    next["sections"] = .array(values)
    await saveSidebar(next)
  }
  func deleteSection(_ id: String) async {
    var next = store.sidebar
    next["sections"] = .array(next["sections"].array.filter { $0["id"].string != id })
    next["sectionByChannel"] = .object(
      next["sectionByChannel"].object.filter { $0.value.string != id })
    next["channelOrderByGroup"] = .object(
      next["channelOrderByGroup"].object.filter { $0.key != id })
    // A formerly collapsed Unassigned group must not conceal the moved chats.
    next["unassignedCollapsed"] = .bool(false)
    await saveSidebar(next)
  }
  func toggleSection(_ id: String) async {
    var next = store.sidebar
    if id.isEmpty {
      next["unassignedCollapsed"] = .bool(!next["unassignedCollapsed"].bool)
    } else {
      var values = next["sections"].array
      if let i = values.firstIndex(where: { $0["id"].string == id }) {
        values[i]["collapsed"] = .bool(!values[i]["collapsed"].bool)
      }
      next["sections"] = .array(values)
    }
    await saveSidebar(next)
  }
  func move(_ channel: String, to section: String) async {
    var next = store.sidebar
    next["sectionByChannel"][channel] = .string(section)
    await saveSidebar(next)
  }
  func markUnread(_ id: String) async {
    var next = store.sidebar
    next["unreadIds"] = .array(
      Array(Set(next["unreadIds"].array.map(\.string) + [id])).map(JSON.string))
    await saveSidebar(next)
  }
}

struct ChannelRow: View {
  @Environment(AppStore.self) private var store
  let channel: Channel
  private var last: Message? { store.messages(channel.id).last }
  private var unread: Bool {
    (channel.unreadCount ?? 0) > 0
      || store.sidebar["unreadIds"].array.map(\.string).contains(channel.id)
  }
  var body: some View {
    HStack(spacing: 16) {
      ChannelAvatar(channel: channel, size: 46)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          Text(channel.name).font(.body.weight(.medium)).foregroundStyle(NativePalette.text)
            .lineLimit(1)
          Spacer(minLength: 8)
          if let date = last?.date {
            Text(dateLabel(date)).font(.system(size: 13)).foregroundStyle(NativePalette.faint)
          }
        }
        HStack {
          if last?.content.isEmpty == true, !(last?.attachments.isEmpty ?? true) {
            Image(systemName: "paperclip").font(.system(size: 13))
          }
          Text(preview).font(.system(size: 15)).lineLimit(1).frame(
            maxWidth: .infinity, alignment: .leading)
          if unread { Circle().fill(NativePalette.link).frame(width: 10, height: 10) }
        }.foregroundStyle(NativePalette.muted)
      }
    }.frame(minHeight: 80).contentShape(Rectangle()).accessibilityElement(children: .combine)
  }
  var preview: String {
    if !store.activeRuns(channel.id).isEmpty { return "Working…" }
    if let last {
      return last.content.isEmpty && !last.attachments.isEmpty ? "Attachment" : last.content
    }
    return store.bot(for: channel)?.description ?? channel.description
  }
  func dateLabel(_ date: Date) -> String {
    if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
    let f = DateFormatter()
    let recent =
      (Calendar.current.dateComponents(
        [.day], from: Calendar.current.startOfDay(for: date),
        to: Calendar.current.startOfDay(for: Date())
      ).day ?? 8)
    f.dateFormat =
      Calendar.current.isDateInToday(date)
      ? "h:mm a" : (recent > 0 && recent < 7 ? "EEEE" : "M/d/yy")
    return f.string(from: date)
  }
}

struct CreateConversationView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  var group = false
  var onCreated: (String) -> Void
  @State private var name = ""
  @State private var selected: Set<String> = []
  @State private var color = "#a47952"
  @State private var shape = "classic"
  @State private var saving = false
  @State private var requestID = UUID().uuidString
  @State private var groupQuery = ""
  @State private var namingGroup = false
  @FocusState private var groupSearchFocused: Bool
  @FocusState private var groupNameFocused: Bool
  private let shapes = RobotShape.allCases.map(\.rawValue)
  private let colors = RobotArtwork.shared.colors
  var body: some View {
    VStack(spacing: 0) {
      if group {
        HStack(spacing: 0) {
          SheetHeading(title: "New Group Chat") {
            if namingGroup {
              namingGroup = false
              groupSearchFocused = true
            } else {
              dismiss()
            }
          }
          if !namingGroup {
            Button("Next") {
              namingGroup = true
              groupNameFocused = true
            }
            .font(.body.weight(.semibold)).foregroundStyle(NativePalette.background)
            .padding(.horizontal, 15).frame(height: 44)
            .background(NativePalette.text.opacity(selected.isEmpty ? 0.45 : 1), in: Capsule())
            .disabled(selected.isEmpty).padding(.trailing, 18)
          }
        }
        if namingGroup {
          TextField("Name your group", text: $name).padding(16).background(
            NativePalette.surface, in: RoundedRectangle(cornerRadius: 14)
          ).padding(16).accessibilityIdentifier("new-name").focused($groupNameFocused)
          Text("\(selected.count) bots selected").font(.footnote).foregroundStyle(
            NativePalette.muted)
        } else {
          HStack(spacing: 6) {
            Text("To:").foregroundStyle(NativePalette.faint)
            TextField("Search Bots", text: $groupQuery).focused($groupSearchFocused)
              .submitLabel(.search).textInputAutocapitalization(.never).autocorrectionDisabled()
              .accessibilityIdentifier("group-search")
          }.padding(.horizontal, 14).frame(height: 42).nativeGlass(radius: 22)
            .padding(.horizontal, 18).padding(.bottom, 16)
        }
        ScrollView {
          LazyVStack(spacing: 0) {
            ForEach(
              store.bots.filter { bot in
                namingGroup
                  ? selected.contains(bot.id)
                  : groupQuery.isEmpty || bot.name.localizedCaseInsensitiveContains(groupQuery)
              }
            ) { bot in
              Button {
                if selected.contains(bot.id) {
                  NativeHaptics.play(.selection, source: "group.member")
                  selected.remove(bot.id)
                } else if selected.count < 6 {
                  NativeHaptics.play(.selection, source: "group.member")
                  selected.insert(bot.id)
                }
              } label: {
                HStack(spacing: 14) {
                  BotGlyph(color: Color(hex: bot.color), kind: bot.icon, size: 34, mode: .idle)
                  Text(bot.name).font(.body).foregroundStyle(NativePalette.text)
                  Spacer()
                  if selected.contains(bot.id) { Image(systemName: "checkmark.circle.fill") }
                }.frame(minHeight: 54).contentShape(Rectangle())
              }.buttonStyle(.plain).accessibilityLabel(bot.name)
                .accessibilityAddTraits(selected.contains(bot.id) ? .isSelected : [])
            }
          }.padding(.horizontal, 22).padding(.top, namingGroup ? 12 : 16)
        }.scrollDismissesKeyboard(.interactively)
          .overlay {
            if !namingGroup && !groupQuery.isEmpty
              && !store.bots.contains(where: {
                $0.name.localizedCaseInsensitiveContains(groupQuery)
              })
            {
              ContentUnavailableView.search(text: groupQuery)
            }
          }
      } else {
        SheetHeading(title: "Create New Bot") { dismiss() }
        GeometryReader { geo in
          ScrollView {
            VStack(spacing: 0) {
              Spacer(minLength: 0).frame(height: max(24, geo.size.height * 0.10 - 4))
              BotGlyph(
                color: Color(hex: color), kind: shape, size: 156, mode: .idle
              )
              .offset(y: 3).accessibilityLabel(
                "Bot avatar")
              Spacer(minLength: 0).frame(height: max(30, geo.size.height * 0.12))
              TextField("Name your Bot", text: $name).font(.system(size: 20, weight: .medium))
                .multilineTextAlignment(.center)
                .padding(.vertical, 14).background(
                  NativePalette.surface, in: RoundedRectangle(cornerRadius: 14)
                )
                .accessibilityIdentifier("new-name")
              LazyVGrid(
                columns: Array(repeating: GridItem(.fixed(44), spacing: 16), count: 4), spacing: 14
              ) {
                ForEach(shapes, id: \.self) { value in
                  Button {
                    if shape != value { NativeHaptics.play(.selection, source: "bot.shape") }
                    shape = value
                  } label: {
                    BotGlyph(color: Color(hex: color), kind: value, size: 38, mode: .idle).padding(
                      3
                    )
                    .overlay(
                      Circle().stroke(
                        shape == value ? NativePalette.muted.opacity(0.6) : .clear, lineWidth: 2)
                    )
                    .contentShape(Rectangle())
                  }.buttonStyle(.plain).accessibilityLabel(value).accessibilityAddTraits(
                    shape == value ? .isSelected : [])
                }
              }.padding(.top, 38)
              VStack(spacing: 13) {
                colorRow(Array(colors.prefix(6)))
                colorRow(Array(colors.suffix(5)))
              }.padding(.top, 30).padding(.bottom, 24)
            }.frame(maxWidth: .infinity)
          }.scrollDismissesKeyboard(.interactively)
        }.padding(.horizontal, 16)
      }
      if !group || namingGroup {
        Button(saving ? "Creating…" : "Create") { Task { await save() } }
          .buttonStyle(PrimaryActionStyle()).disabled(
            saving || store.syncingState || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              || (group && (selected.isEmpty || selected.count > 6 || name.count > 80))
          )
          .accessibilityIdentifier("create-confirm").padding(.horizontal, 28).padding(.bottom, -4)
          .padding(.top, 12)
      }
    }.disabled(saving).interactiveDismissDisabled(saving).nativeCanvas()
      .onAppear { if group { groupSearchFocused = true } }
  }
  func colorRow(_ values: [String]) -> some View {
    HStack(spacing: 31) {
      ForEach(values, id: \.self) { value in
        Button {
          if color != value { NativeHaptics.play(.selection, source: "bot.color") }
          color = value
        } label: {
          Circle().fill(Color(hex: value)).frame(width: 25, height: 25).padding(3)
            .overlay(
              Circle().stroke(
                color == value ? NativePalette.muted.opacity(0.6) : .clear, lineWidth: 2))
        }.buttonStyle(.plain).accessibilityLabel("Color " + value)
      }
    }
  }
  func save() async {
    guard !saving, !store.syncingState else { return }
    saving = true
    defer { saving = false }
    let body: JSON =
      group
      ? .object([
        "clientId": .string(requestID),
        "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
        "description": .string(""),
        "botIds": .array(selected.sorted().map(JSON.string)),
        "timeZone": .string(TimeZone.current.identifier),
      ])
      : .object([
        "clientRequestId": .string(requestID),
        "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
        "description": .string(""),
        "instructions": .string(""), "color": .string(color), "icon": .string(shape),
      ])
    if let result = await store.mutate(
      group ? "/api/v0/channels" : "/api/v0/bots", body: body, successFeedback: .success,
      feedbackSource: "conversation.create")
    {
      let id = group ? result["id"].string : result["dmChannelId"].string
      if !id.isEmpty { onCreated(id) }
    }
  }
}

struct SearchView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  var onSelect: (String, String?, String?) -> Void
  @State private var query = ""
  @State private var category = "all"
  @State private var results: [SearchResult] = []
  @State private var loading = false
  @State private var failure: String?
  @State private var retryID = 0
  @FocusState private var focused: Bool
  private var searchQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
  var body: some View {
    ScrollView {
      LazyVStack(spacing: 0) {
        if loading { ProgressView().padding() }
        if let failure { InlineFailure(message: failure) { retryID += 1 }.padding() }
        if searchQuery.isEmpty {
          ForEach(store.channels.filter { !store.isHidden($0) }) { channel in
            Button {
              focused = false
              onSelect(channel.id, nil, nil)
            } label: {
              searchRow(
                channel: channel, title: channel.name,
                subtitle: store.bot(for: channel)?.description
                  ?? (channel.description.isEmpty && channel.isGroup ? "Group Chat" : channel.description),
                kind: channel.isGroup ? "Group Chat" : "Bot")
            }.buttonStyle(.plain)
          }
        }
        ForEach(results) { result in
          Button {
            if result.kind == "link", let raw = result.url, let url = URL(string: raw),
              ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "")
            {
              openURL(url)
              return
            }
            if let channel = result.channelId
              ?? store.bots.first(where: { $0.id == result.botId })?.dmChannelId
            {
              focused = false
              let routine =
                result.kind == "routine"
                ? (result.id.hasPrefix("routine:") ? String(result.id.dropFirst(8)) : result.id)
                : nil
              onSelect(channel, routine == nil ? result.messageId : nil, routine)
            } else {
              failure = "This result is no longer available. Search again to refresh the results."
            }
          } label: {
            searchRow(
              channel: store.channel(result.channelId ?? ""), title: result.title,
              subtitle: result.subtitle, kind: result.kind.capitalized)
          }.buttonStyle(.plain)
        }
        if !loading, !searchQuery.isEmpty, results.isEmpty, failure == nil {
          ContentUnavailableView.search(text: searchQuery)
        }
      }.padding(.horizontal, 20).padding(.top, 18)
    }.scrollDismissesKeyboard(.interactively)
      .scrollClipDisabled()
      .floatingBar(edge: .top) { header }
      .nativeCanvas()
      .task { focused = true }
      .task(id: query + "\n" + category + "\n" + String(retryID)) {
        results = []
        failure = nil
        guard !searchQuery.isEmpty, store.api != nil else {
          loading = false
          return
        }
        loading = true
        do {
          try await Task.sleep(for: .milliseconds(250))
          let response = try await store.fetch(
            "/api/v0/search", as: SearchResponse.self, query: ["q": searchQuery, "category": category])
          try Task.checkCancellation()
          results = response.results
          loading = false
        } catch {
          if !Task.isCancelled {
            failure = UserFacingError.message(error)
            loading = false
          }
        }
      }
  }
  private var header: some View {
    HStack(spacing: 8) {
      ChromeButton(title: "Close", symbol: "xmark") { dismiss() }.accessibilityIdentifier(
        "sheet-close")
      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass").foregroundStyle(NativePalette.faint).font(
          .system(size: 17))
        TextField("Search", text: $query).font(.system(size: 17)).textInputAutocapitalization(
          .never
        ).autocorrectionDisabled().focused($focused).submitLabel(
          .search
        ).tint(NativePalette.chatInsertion).accessibilityIdentifier("search-input")
        if !query.isEmpty {
          Button("Clear", systemImage: "xmark.circle.fill") { query = "" }.labelStyle(.iconOnly)
            .foregroundStyle(NativePalette.muted)
        }
      }.padding(.horizontal, 14).frame(height: 44).nativeGlass()
      Menu {
        Picker("Search in", selection: $category.hapticSelection("search.category")) {
          ForEach(
            ["all", "messages", "bots", "channels", "files", "links", "routines"], id: \.self
          ) { Text($0.capitalized).tag($0) }
        }
      } label: {
        Image(systemName: "line.3.horizontal.decrease").font(.system(size: 20)).frame(
          width: 44, height: 44
        ).nativeGlass()
      }
    }.padding(.horizontal, 18).padding(.top, 18).padding(.bottom, 14)
  }
  func searchRow(channel: Channel?, title: String, subtitle: String, kind: String) -> some View {
    HStack(spacing: 14) {
      if let channel { ChannelAvatar(channel: channel, size: 48) }
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(title).font(.system(size: 17, weight: .medium)).lineLimit(1)
          Spacer()
          Text(kind).font(.system(size: 13)).foregroundStyle(NativePalette.faint)
        }
        if !subtitle.isEmpty {
          Text(subtitle).font(.system(size: 15)).foregroundStyle(NativePalette.muted).lineLimit(1)
        }
      }
    }.frame(minHeight: 80).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
      .accessibilityElement(children: .combine)
  }
}

/// The inbox is a free-scrolling stack, so List-only swipeActions cannot receive
/// its gestures. Keep the same deliberate Pin/Hide actions as the RN inbox.
private struct ConversationSwipeRow<Content: View>: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let pinned: Bool
  let pin: () -> Void
  let hide: () -> Void
  @ViewBuilder let content: () -> Content
  @State private var offset: CGFloat = 0
  @State private var origin: CGFloat = 0
  @State private var dragging = false
  var body: some View {
    ZStack {
      HStack {
        swipeButton(pinned ? "Unpin" : "Pin", "pin.fill", NativePalette.warning, action: pin)
          .opacity(offset > 0 ? 1 : 0).allowsHitTesting(offset > 0).accessibilityHidden(offset <= 0)
        Spacer()
        swipeButton("Hide", "eye.slash", NativePalette.destructive, action: hide)
          .opacity(offset < 0 ? 1 : 0).allowsHitTesting(offset < 0).accessibilityHidden(offset >= 0)
      }.padding(.horizontal, 8)
      content().background(NativePalette.background).offset(x: offset)
        .gesture(
          MessageReplyGesture(
            allowsLeftward: true,
            onChanged: { translation in
              if !dragging {
                origin = offset
                dragging = true
              }
              offset = min(82, max(-82, origin + translation.width))
            },
            onEnded: { _, velocity, cancelled in
              dragging = false
              let target: CGFloat = cancelled ? 0 : abs(offset) >= 40 ? (offset > 0 ? 76 : -76) : 0
              withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) { offset = target }
            }))
    }
  }
  private func swipeButton(
    _ title: String, _ icon: String, _ color: Color, action: @escaping () -> Void
  ) -> some View {
    Button {
      withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) { offset = 0 }
      NativeHaptics.play(.light, source: "conversation.swipe-action")
      action()
    } label: {
      Image(systemName: icon).font(.body.weight(.semibold)).foregroundStyle(.white)
        .frame(width: 44, height: 44).background(color, in: Circle()).contentShape(Circle())
    }.buttonStyle(.plain).accessibilityLabel(title).accessibilityIdentifier(
      "conversation-swipe-" + title.lowercased())
  }
}
