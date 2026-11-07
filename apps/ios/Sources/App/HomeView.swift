import SwiftUI

struct HomeView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.displayScale) private var displayScale
  /// Rows are zoom sources for the first bot's chat after onboarding.
  @Namespace private var zoom
  /// The chat that opens with the zoom transition; kept until it's closed again.
  @State private var zoomChannel: String?
  /// Settings, optionally opened at a page such as Model from the banner.
  private struct SettingsSheet: Identifiable {
    let id = UUID()
    var route: SettingsRoute?
  }
  @State private var settings: SettingsSheet?
  @State private var marketplace = false
  @State private var marketplaceRevision = 0
  @State private var marketplaceHovered = false
  @State private var accountHovered = false
  @State private var lastUnread: String?
  @State private var splitAvailable = false
  private var referenceSidebar: Bool { UIDevice.current.userInterfaceIdiom == .pad || barRegions.hasHinge }
  private var expandedReferenceSidebar: Bool { referenceSidebar && splitAvailable && !listHidden }
  private var unreadChannels: [Channel] { visible.filter { store.isUnread($0) } }
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
  @State private var listHidden = false
  @State private var portraitLayout = false
  @State private var barRegions = BarRegions.none
  /// The conversation list's width beside a chat, as last dragged; 0 until then.
  @AppStorage("sidebarWidth") private var draggedSidebarWidth: Double = 0
  @State private var dragStartWidth: CGFloat?
  @Environment(\.horizontalSizeClass) private var sizeClass
  private var visible: [Channel] { store.channels.filter { $0.kind != "agent_dm" } }
  private var sections: [JSON] { store.sidebar["sections"].array }
  var body: some View {
    GeometryReader { geometry in
      let split = sizeClass == .regular || (barRegions.hasHinge && geometry.size.width >= 650)
      let portrait = split && geometry.size.height > geometry.size.width
      let systemChrome = SideChrome(
        regions: barRegions, insets: geometry.safeAreaInsets, holdsAllControls: sizeClass == .compact)
      // In rotations without a right-hand system region, reserve a column so
      // these controls stay on the right without covering the conversation.
      let reservesRightColumn = !portrait && barRegions.hasHinge
        && (split || barRegions.sideEdge != nil) && systemChrome?.edge != .trailing
      let chrome: SideChrome? = portrait ? nil : reservesRightColumn
        ? SideChrome(rightColumnHoldingAllControls: sizeClass == .compact) : systemChrome
      let rightColumnWidth = reservesRightColumn ? SideChrome.rightColumnWidth : 0
      Group {
        if split {
          splitLayout(width: geometry.size.width - rightColumnWidth, fold: HomeLayout.fold(in: geometry))
        } else { stackLayout }
      }
      .onChange(of: split, initial: true) { _, value in splitAvailable = value }
      .overlay(alignment: .topTrailing) {
        if !split, barRegions.hasHinge, barRegions.sideEdge == nil {
          HStack(spacing: 12) {
            if splitAvailable { sidebarToggle }
            searchControl
            creationMenu().frame(width: 44, height: 44).nativeInboxGlass()
            if !expandedReferenceSidebar, store.navigation.isEmpty {
              MarketplaceShortcut { marketplace = true }
              accountControl
            }
          }.padding(.trailing, 18).padding(.top, 6)
        }
      }
      .overlay(alignment: .topLeading) {
        if splitAvailable, listHidden, portrait || !barRegions.hasHinge, store.navigation.isEmpty {
          inboxHeader(isSidebar: false)
        }
      }
      .modifier(SideChromeBar(top: EmptyView?.none, side: sideActions))
      .environment(\.sideChrome, chrome)
      // Use the space beside Duo's status cluster instead of its full top band.
      .environment(\.topBarClearance, split && barRegions.hasHinge
        ? max(0, barRegions.top - SideChrome.topBarPadding)
        : SideChrome.topBarClearance(barRegions, insets: geometry.safeAreaInsets))
      .environment(\.usesTopToolbarGuide, !(split && barRegions.hasHinge))
      .environment(\.leadingChatTitle, portrait)
      .environment(\.topBarTrailingInset, portrait && barRegions.hasHinge
        ? max(systemChrome?.width ?? 0, SideChrome.topStatusWidth) : 0)
      .onChange(of: portrait, initial: true) { _, value in portraitLayout = value }
    }
    .ignoresSafeArea(.container, edges: splitAvailable && barRegions.hasHinge
      ? (portraitLayout ? [.top, .trailing] : [.top]) : [])
    .background { NativePalette.sidebar.ignoresSafeArea() }
    .readingBarRegions { barRegions = $0 }
    .onChange(of: store.navigation) { _, path in
      // Once the zoomed chat has closed (and zoomed back into its row), later
      // opens push as usual.
      guard path.isEmpty, zoomChannel != nil, store.landing == nil else { return }
      Task {
        try? await Task.sleep(for: .seconds(1))
        if store.navigation.isEmpty, store.landing == nil { zoomChannel = nil }
      }
    }
    .sheet(isPresented: $marketplace, onDismiss: { marketplaceRevision += 1 }) {
      NavigationStack { PluginListView() }.referenceSheet()
    }
    .sheet(item: $settings) { sheet in
      SettingsView(initialRoute: sheet.route).referenceSheet()
    }
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
    // Above the layouts rather than on a page: opening the chat covers the root
    // page, and a fold changes layout; either would cancel the task and restart it
    // (and open the chat again).
    .task(id: store.landing) { await land() }
    .onChange(of: store.botVoiceLaunch.presentation) { _, _ in
      pendingOpen = nil
      pendingRoutine = nil
      settings = nil
      creation = nil
      search = false
    }
  }
  /// Compact width (a folded iPhone Duo or any iPhone in portrait) pushes chats
  /// over the list.
  private var stackLayout: some View {
    @Bindable var store = store
    return NavigationStack(path: $store.navigation) {
      conversationList()
        .navigationDestination(for: String.self) { id in
          if id == zoomChannel {
            conversation(id).navigationTransition(.zoom(sourceID: id, in: zoom))
          } else {
            conversation(id)
          }
        }
    }
  }
  /// Regular width (iPhone Duo's inner display, iPad, Max iPhones in landscape)
  /// keeps the conversation list beside the open chat, as Settings does there.
  /// The chat's leading button hides the list for a full-width chat.
  private func splitLayout(width: CGFloat, fold: CGRect?) -> some View {
    let selected = store.navigation.last.flatMap { store.channel($0) }
    let showsList = !listHidden
    let range = HomeLayout.sidebarRange(for: width)
    // Partly folded, the columns meet at the fold, as Notes' do, so neither
    // spans it; each keeps its content clear of the fold's band.
    let foldInset = (fold?.width ?? 0) / 2
    let draggedWidth: CGFloat = draggedSidebarWidth > 0
      ? min(range.upperBound, max(range.lowerBound, CGFloat(draggedSidebarWidth)))
      : (referenceSidebar ? SidebarMetrics.width : HomeLayout.sidebarWidth(for: width))
    let listWidth: CGFloat = fold?.midX ?? draggedWidth
    return HStack(spacing: 0) {
      if showsList {
        // A gray column, edge to edge, beside the chat; the open chat is a card on it.
        conversationList(isSidebar: referenceSidebar)
          .environment(\.canvasColor, referenceSidebar ? SidebarFooterFade.canvas : NativePalette.sidebar)
          // The list never reaches the side region beside a chat.
          .environment(\.sideChrome, nil)
          .safeAreaPadding(.trailing, foldInset)
          .frame(width: listWidth)
          .overlay(alignment: .trailing) {
            NativePalette.separator.frame(width: 1 / displayScale)
              .ignoresSafeArea(.container, edges: .vertical)
              .allowsHitTesting(false).accessibilityHidden(true)
          }
          .transition(.move(edge: .leading).combined(with: .opacity))
      }
      if let selected {
        NavigationStack {
          ChatView(channel: selected)
            .ignoresSafeArea(.container, edges: barRegions.hasHinge ? .top : [])
            .environment(\.botVoicePresentation, store.botVoiceLaunch.presentation)
            .id(store.botVoiceLaunch.presentation)
        }
          // A different chat starts with its own pushed details and threads.
          .id(selected.id)
          .environment(
            \.chatLeadingControl,
            ChatLeadingControl(title: listHidden ? "Show conversations" : "Hide conversations", external: barRegions.hasHinge && !portraitLayout) {
              withAnimation(.smooth(duration: 0.3)) { listHidden.toggle() }
            })
          .safeAreaPadding(.leading, showsList ? foldInset : 0)
          .environment(\.chatColumnLeading, showsList ? listWidth : 0)
          .environment(\.conversationListVisible, showsList)
          .frame(maxWidth: .infinity)
      } else {
        IdleConversationView()
      }
    }
    // Above both columns, so neither scroll view takes the drag.
    .animation(.smooth(duration: 0.3), value: fold)
    .overlay(alignment: .leading) {
      if showsList, fold == nil {
        SidebarResizeHandle(
          width: listWidth, range: range, dragging: dragStartWidth != nil,
          onDrag: { translation in
            let start = dragStartWidth ?? listWidth
            dragStartWidth = start
            draggedSidebarWidth = min(range.upperBound, max(range.lowerBound, start + translation))
          },
          onEnd: { translation in
            // Dragging well past the narrowest width hides the list beside a
            // chat; it comes back at the width it had before.
            let start = dragStartWidth ?? listWidth
            if selected != nil, start + translation < range.lowerBound - 80 {
              draggedSidebarWidth = start
              withAnimation(.smooth(duration: 0.3)) { listHidden = true }
            }
            dragStartWidth = nil
          },
          onSet: { draggedSidebarWidth = $0 })
          .offset(x: listWidth - SidebarResizeHandle.hitWidth / 2)
      }
    }
    // Lists slide over the page color, not the window, as they collapse.
    .nativeCanvas()
    .environment(\.opensConversationsInPlace, true)
  }
  private func conversationList(isSidebar: Bool = false) -> some View {
    GeometryReader { geometry in
      let clearance = isSidebar ? SidebarMetrics.footerBottom : 0
      ScrollViewReader { proxy in
        ZStack(alignment: .bottom) {
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
              if let banner = ModelStatusBanner(inference: store.runtime.inference) {
                ModelStatusBannerView(banner: banner) {
                  settings = SettingsSheet(route: .model)
                }.padding(.top, 4).padding(.bottom, 8)
              }
              if !store.pins.isEmpty {
                ScrollView(.horizontal) {
                  HStack(alignment: .top, spacing: 20) {
                    ForEach(store.pins.compactMap { id in visible.first { $0.id == id } }) { channel in
                      ConversationLink(id: channel.id, highlightsSelection: false) {
                        VStack(spacing: 7) {
                          ChannelAvatar(channel: channel, size: 80)
                          Text(channel.name).font(.subheadline).foregroundStyle(NativePalette.muted)
                            .lineLimit(1)
                        }.frame(width: 100).contentShape(Rectangle())
                      }.accessibilityIdentifier("pinned-" + channel.id)
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
                  collapsed: section["collapsed"].bool, isSidebar: isSidebar)
              }
              sectionView(
                id: "", name: "Unassigned",
                collapsed: !sections.isEmpty && store.sidebar["unassignedCollapsed"].bool,
                showsHeading: !sections.isEmpty, isSidebar: isSidebar)
              if visible.isEmpty && store.bots.isEmpty && store.state.bootstrap != nil {
                // Desktop's empty state: a server without bots has nothing to chat with yet.
                VStack(alignment: .leading, spacing: 12) {
                  Text("Bots do the work in OpenTeam. Create one to get started.")
                    .font(.subheadline).foregroundStyle(NativePalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                  Button("Create a bot") { if !store.syncingState { creation = .bot } }
                    .buttonStyle(ModelCapsuleButtonStyle(primary: true))
                    .disabled(store.syncingState)
                    .accessibilityIdentifier("empty-create-bot")
                }
                .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("empty-conversations")
              } else if visible.isEmpty {
                Text("No conversations yet")
                  .font(.subheadline).foregroundStyle(NativePalette.muted)
                  .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
                  .accessibilityIdentifier("empty-conversations")
              }
            }
            .padding(.leading, isSidebar ? SidebarMetrics.rowLeading : 20)
            .padding(.trailing, isSidebar ? SidebarMetrics.rowTrailing : 20)
            .padding(.top, isSidebar && barRegions.hasHinge && !portraitLayout
              ? SidebarMetrics.landscapeTopClearance : 0)
            .padding(.bottom, isSidebar ? 94 : 30)
          }.background(isSidebar ? SidebarFooterFade.canvas : NativePalette.background)
            .scrollIndicators(.hidden)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { contentWidth = $0 }
            .padding(.trailing, !isSidebar && sizeClass == .compact && barRegions.hasHinge && barRegions.sideEdge != nil && barRegions.sideEdge != .trailing
              ? SideChrome.rightColumnWidth : 0)
            .fadingTopBar(canvas: isSidebar ? SidebarFooterFade.canvas : NativePalette.background,
              showsFade: portraitLayout || !barRegions.hasHinge) {
              if portraitLayout || !barRegions.hasHinge { inboxHeader(isSidebar: isSidebar) }
            }
            .mask {
              if isSidebar {
                VStack(spacing: 0) {
                  Color.black
                  LinearGradient(stops: [
                    .init(color: .black, location: 0), .init(color: .black, location: 0.38),
                    .init(color: .black.opacity(0.6), location: 0.52),
                    .init(color: .clear, location: 0.7), .init(color: .clear, location: 1),
                  ], startPoint: .top, endPoint: .bottom).frame(height: 132 + clearance)
                }
              } else { Color.black }
            }
            .refreshable { await store.refresh() }
          if isSidebar {
            SidebarFooterFade().frame(height: 132 + clearance).ignoresSafeArea(edges: .bottom)
            accountFooter.padding(.bottom, clearance)
          }
        }
        .overlay(alignment: .bottom) {
          if !unreadChannels.isEmpty {
            UnreadPill(count: unreadChannels.count, isSidebar: isSidebar) {
              let ids = unreadChannels.map(\.id)
              let next = lastUnread.flatMap { ids.firstIndex(of: $0) }.map { ($0 + 1) % ids.count } ?? 0
              let id = ids[next]
              lastUnread = id
              Task {
                await revealUnread(id)
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) { proxy.scrollTo(id, anchor: .center) }
              }
            }.padding(.bottom, isSidebar ? SidebarMetrics.unreadBottom + clearance : 12)
              .accessibilityIdentifier("inbox-unread")
          }
        }
        .background {
          (isSidebar ? SidebarFooterFade.canvas : NativePalette.background).ignoresSafeArea()
        }
        .toolbar(.hidden, for: .navigationBar)
      }
    }.ignoresSafeArea(.container, edges: isSidebar ? .bottom : [])
  }
  @ViewBuilder private func conversation(_ id: String) -> some View {
    if let channel = store.channel(id) {
      ChatView(channel: channel)
        .environment(\.botVoicePresentation, store.botVoiceLaunch.presentation)
        .id(store.botVoiceLaunch.presentation)
    } else {
      ContentUnavailableView("Conversation unavailable", systemImage: "bubble.left")
    }
  }
  /// After onboarding (W8): the new bot's row springs into the list, Home holds a
  /// beat, then the chat zooms out of the row and the greeting arrives there. The
  /// notification question waits until the greeting has settled.
  private func land() async {
    guard let id = store.landing else { return }
    if !reduceMotion { zoomChannel = id }
    // The row lands at about 0.9 s and its glow fades by 1.5 s; the chat opens a beat
    // after that, once the row is still.
    try? await Task.sleep(for: .milliseconds(reduceMotion ? 900 : 1650))
    guard !Task.isCancelled, store.landing == id else { return }
    if store.navigation.isEmpty, store.channel(id) != nil { store.navigation = [id] }
    let opened = ContinuousClock.now
    while !Task.isCancelled, ContinuousClock.now - opened < .seconds(25) {
      if let latest = store.latestMessage(id), !latest.isUser { break }
      try? await Task.sleep(for: .milliseconds(250))
    }
    guard !Task.isCancelled else { return }
    try? await Task.sleep(for: .milliseconds(1400))
    guard !Task.isCancelled else { return }
    store.finishLanding()
  }
  private var accountFooter: some View {
    GeometryReader { geometry in
      ZStack(alignment: .trailing) {
        HStack(spacing: 0) {
          Button {
            settings = SettingsSheet()
          } label: {
            HStack(spacing: SidebarMetrics.accountGap) {
              SidebarAccountMark(name: store.accountDisplayName)
              Text(store.accountDisplayName)
                .font(
                  portraitLayout ? .body.weight(.medium) : .system(size: SidebarMetrics.accountFont)
                )
                .lineLimit(1)
                .foregroundStyle(accountHovered ? NativePalette.chatMuted : NativePalette.text)
                .opacity(marketplaceHovered ? 0 : 1)
                .blur(radius: marketplaceHovered && !reduceMotion ? 2 : 0)
                .accessibilityIdentifier("sidebar-account-name")
            }.frame(height: 44).contentShape(Rectangle())
          }.buttonStyle(.plain).accessibilityLabel("Settings, " + store.accountDisplayName)
            .accessibilityIdentifier("settings-button")
            .onHover { inside in
              withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) { accountHovered = inside }
            }
          Spacer(minLength: 0)
        }.padding(.trailing, 90)
        MarketplaceShortcut(
          compact: true, revision: marketplaceRevision,
          expandedWidth: geometry.size.width - SidebarMetrics.accountSize
            - SidebarMetrics.accountGap,
          onExpansionChange: { marketplaceHovered = $0 }
        ) { marketplace = true }
        .fixedSize()
      }
    }.frame(height: 44).padding(.leading, SidebarMetrics.leading).padding(
      .trailing, SidebarMetrics.trailing)
  }
  private func revealUnread(_ id: String) async {
    let sectionID = store.sidebar["sectionByChannel"][id].string
    if let section = sections.first(where: { $0["id"].string == sectionID }) {
      if section["collapsed"].bool { await toggleSection(sectionID) }
    } else if store.sidebar["unassignedCollapsed"].bool {
      await toggleSection("")
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
  private var sidebarToggle: some View {
    InboxChromeButton(title: listHidden ? "Show sidebar" : "Hide sidebar", symbol: "sidebar.left") {
      withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.22)) { listHidden.toggle() }
    }.accessibilityIdentifier("sidebar-toggle")
  }
  private var accountControl: some View {
    Button { settings = SettingsSheet() } label: {
      AccountMark(name: store.accountDisplayName, size: 32, initialsScale: 0.42)
        .frame(width: 44, height: 44).nativeInboxGlass()
    }.buttonStyle(.plain).accessibilityLabel("Settings, " + store.accountDisplayName)
      .accessibilityIdentifier("settings-button")
  }
  private var searchControl: some View {
    InboxChromeButton(title: "Search", symbol: "magnifyingglass") { search = true }
      .accessibilityIdentifier("search-button")
  }
  private func inboxHeader(isSidebar: Bool) -> some View {
    HStack(spacing: isSidebar ? 8 : 4) {
      if splitAvailable { sidebarToggle }
      if !isSidebar { accountControl }
      if store.syncingState {
        HStack(spacing: 8) {
          LoadingOrb(size: 16).accessibilityHidden(true)
          Text("Syncing state").font(.body.weight(.semibold)).lineLimit(1)
        }.padding(.leading, 12).accessibilityElement(children: .combine)
          .accessibilityIdentifier("syncing-state")
      }
      Spacer()
      MobileUpdateBadge()
      InboxChromeButton(title: "Search", symbol: "magnifyingglass",
        pointSize: isSidebar ? SidebarMetrics.searchGlyph : 21) { search = true }
        .accessibilityIdentifier("search-button")
      creationMenu(pointSize: isSidebar ? SidebarMetrics.addGlyph : 20)
        .frame(width: 44, height: 44).nativeInboxGlass()
    }.foregroundStyle(NativePalette.text).padding(.leading, 18)
      .padding(.trailing, isSidebar ? SidebarMetrics.toolbarTrailing : 18)
      .modifier(TopBarClearance(isSidebar ? SidebarMetrics.toolbarTop : SideChrome.topBarPadding))
      .padding(.bottom, 10)
  }
  /// Shared by the list and chat so Duo's sidebar toggle stays on the right.
  private var sideActions: some View {
    VStack(spacing: 12) {
      if splitAvailable { sidebarToggle }
      creationMenu().frame(width: 44, height: 44).nativeInboxGlass()
      searchControl
      Spacer(minLength: 12)
      if !expandedReferenceSidebar, store.navigation.isEmpty {
        MarketplaceShortcut { marketplace = true }
        accountControl
      }
    }.foregroundStyle(NativePalette.text)
  }
  private func creationMenu(pointSize: CGFloat = 20) -> some View {
    NativeActionMenu(symbol: "plus", pointSize: pointSize, title: "New conversation",
      identifier: "new-button", panelIdentifier: "creation-menu-panel",
      hapticSource: "home.create", systemMenu: true, actions: [
        .init(title: "New Bot", action: { if !store.syncingState { creation = .bot } }),
        .init(title: "New Group Chat", action: { if !store.syncingState { creation = .group } }),
      ]).disabled(store.syncingState)
  }

  func sectionView(id: String, name: String, collapsed: Bool, showsHeading: Bool = true, isSidebar: Bool = false)
    -> some View
  {
    let sorted = sortedRows(in: id)
    return VStack(alignment: .leading, spacing: 0) {
      if showsHeading {
        Button {
          Task { await toggleSection(id) }
        } label: {
          HStack(spacing: 7) {
            Text(collapsed ? "\(name) \(sorted.count)" : name).font(.system(size: 14))
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
            pin: { Task { await store.togglePin(channel.id) } }
          ) {
            ConversationLink(id: channel.id, isSidebar: isSidebar) {
              ChannelRow(channel: channel, isSidebar: isSidebar).modifier(ZoomSource(id: channel.id, namespace: zoom))
            }
              .accessibilityIdentifier("channel-" + channel.id)
              .contextMenu {
                conversationActions(channel)
              } preview: {
                conversationPreview(channel)
              }
          }
          .modifier(
            LandingArrival(
              active: channel.id == store.landing,
              tint: Color(hex: store.bot(for: channel)?.color ?? "08C875")))
        }
      }
    }
  }
  /// Unpinned chats in a section (or Unassigned, for an empty ID) in list order.
  private func sortedRows(in id: String) -> [Channel] {
    let validIDs = Set(sections.map { $0["id"].string })
    let rows = visible.filter {
      let assigned = store.sidebar["sectionByChannel"][$0.id].string
      return !store.pins.contains($0.id)
        && (id.isEmpty ? !validIDs.contains(assigned) : assigned == id)
    }
    let order = store.sidebar["channelOrderByGroup"][id.isEmpty ? "unassigned" : id].array.map(
      \.string)
    return rows.sorted { a, b in
      if let ai = order.firstIndex(of: a.id) { return ai < (order.firstIndex(of: b.id) ?? Int.max) }
      if order.contains(b.id) { return false }
      return a.updatedAt > b.updatedAt
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

/// The first bot's row arriving after onboarding: it springs up into place, its
/// color glows behind it for a moment, and a light tap marks it. Reduce Motion fades it.
private struct LandingArrival: ViewModifier {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let active: Bool
  let tint: Color
  @State private var arrived = false
  @State private var glowing = false
  func body(content: Content) -> some View {
    let waiting = active && !arrived
    let moving = waiting && !reduceMotion
    content
      .background {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .fill(tint.opacity(glowing ? 0.16 : 0))
          .padding(.horizontal, -10)
          .allowsHitTesting(false)
      }
      .scaleEffect(moving ? 0.9 : 1, anchor: .top)
      .offset(y: moving ? 34 : 0)
      .blur(radius: moving ? 8 : 0)
      .opacity(waiting ? 0 : 1)
      .onAppear {
        guard active, !arrived else { return }
        withAnimation(
          (reduceMotion ? Animation.easeOut(duration: 0.3) : .bouncy(duration: 0.6, extraBounce: 0.1))
            .delay(0.3)
        ) { arrived = true }
        guard !reduceMotion else { return }
        withAnimation(.smooth(duration: 0.4).delay(0.45)) { glowing = true }
        Task { @MainActor in
          try? await Task.sleep(for: .milliseconds(560))
          NativeHaptics.play(.light, source: "home.first-bot")
          try? await Task.sleep(for: .milliseconds(340))
          withAnimation(.smooth(duration: 0.55)) { glowing = false }
        }
      }
  }
}

/// Explains why bots are silent when the server has no working model.
struct ModelStatusBannerView: View {
  let banner: ModelStatusBanner
  var action: () -> Void
  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      Image(systemName: "exclamationmark.circle.fill").foregroundStyle(NativePalette.warning)
        .accessibilityHidden(true)
      Text(banner.message).font(.footnote).foregroundStyle(NativePalette.text)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
      Button(banner.action) {
        NativeHaptics.play(.light, source: "home.model-banner")
        action()
      }
      .font(.footnote.weight(.semibold)).foregroundStyle(NativePalette.text)
      .padding(.horizontal, 12).frame(minHeight: 32)
      .background(NativePalette.warning.opacity(0.18), in: Capsule())
      .buttonStyle(.plain)
      .accessibilityIdentifier("model-status-banner-action")
    }
    .padding(.leading, 12).padding(.trailing, 8).padding(.vertical, 8)
    .background(NativePalette.warning.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
    .overlay {
      RoundedRectangle(cornerRadius: 14).strokeBorder(NativePalette.warning.opacity(0.2), lineWidth: 0.5)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("model-status-banner")
  }
}

extension AppStore {
  func isUnread(_ channel: Channel) -> Bool {
    (channel.unreadCount ?? 0) > 0
      || sidebar["unreadIds"].array.map(\.string).contains(channel.id)
  }
}

/// Compact width (a folded iPhone Duo, any iPhone in portrait) stacks chats over
/// the list; regular width shows them side by side.
enum HomeLayout: Equatable {
  case stack, split
  init(sizeClass: UserInterfaceSizeClass?) { self = sizeClass == .regular ? .split : .stack }
  /// About a third of the window, as Settings uses on iPhone Duo and iPad.
  static func sidebarWidth(for width: CGFloat) -> CGFloat { min(360, max(280, (width * 0.36).rounded())) }
  /// The fold's band while iPhone Duo is partly folded, when it divides the inner display.
  static func fold(in geometry: GeometryProxy) -> CGRect? {
    guard #available(iOS 27.1, *) else { return nil }
    return geometry.reservedRegions(kind: .division)
      .first { $0.isActive && $0.frame.height > $0.frame.width }?.frame
  }
  /// How far the list can be dragged: never under 240 pt, never over half the window.
  static func sidebarRange(for width: CGFloat) -> ClosedRange<CGFloat> {
    240...max(sidebarWidth(for: width), min(480, (width / 2).rounded()))
  }
}

/// The conversation list's trailing edge, which drags to resize it, as split
/// views' column dividers do. A double tap returns it to its usual width.
private struct SidebarResizeHandle: View {
  static let hitWidth: CGFloat = 20
  var width: CGFloat
  var range: ClosedRange<CGFloat>
  var dragging: Bool
  var onDrag: (CGFloat) -> Void
  var onEnd: (CGFloat) -> Void
  var onSet: (Double) -> Void
  var body: some View {
    Capsule()
      // Shown only while it drags, as the edge itself is the affordance.
      .fill(NativePalette.muted.opacity(dragging ? 0.6 : 0))
      .frame(width: dragging ? 5 : 4, height: 36)
      .frame(width: Self.hitWidth)
      .frame(maxHeight: .infinity)
      .contentShape(Rectangle())
      .highPriorityGesture(
        DragGesture(minimumDistance: 2, coordinateSpace: .global)
          .onChanged { onDrag($0.translation.width) }
          .onEnded { onEnd($0.translation.width) }
      )
      .onTapGesture(count: 2) { onSet(0) }
      .animation(.snappy(duration: 0.15), value: dragging)
      .accessibilityElement()
      .accessibilityLabel("Conversation list width")
      .accessibilityValue("\(Int(width)) points")
      .accessibilityIdentifier("sidebar-resize")
      .accessibilityAdjustableAction { direction in
        let step: CGFloat = direction == .increment ? 40 : -40
        onSet(Double(min(range.upperBound, max(range.lowerBound, width + step))))
      }
  }
}

/// iPhone Duo's outer display gives the status bar its own region down one
/// side, and apps put their controls in that region below it, as Apple's apps
/// and system toolbars do. The region's edge and span come from iOS, so the
/// controls move when the status area grows, as with a Live Activity.
struct SideChrome: Equatable {
  static let rightColumnWidth: CGFloat = 72
  /// Space for the portrait clock and connectivity cluster above the content.
  static let topStatusWidth: CGFloat = 140
  /// Reserve this width inside the page when UIKit provides no right-side region.
  var contentInset: CGFloat = 0
  var edge: HorizontalEdge
  /// The region's width.
  var width: CGFloat
  /// How far from the screen's edge controls center, in line with the status bar.
  var center: CGFloat
  /// Whether the compact chat uses a title-only top bar.
  var holdsAllControls: Bool
  /// Space from the safe area's top and bottom to the region's usable span.
  var controlsTop: CGFloat
  var controlsBottom: CGFloat
  /// Top bars' padding above their controls.
  static let topBarPadding: CGFloat = 6
  /// Room above top bars where iOS places top bars lower than the safe area, as
  /// on iPhone Duo, where they center level with the clock beside it.
  static func topBarClearance(_ regions: BarRegions, insets: EdgeInsets) -> CGFloat {
    max(0, regions.top - insets.top - topBarPadding)
  }
  init?(regions: BarRegions, insets: EdgeInsets, holdsAllControls: Bool) {
    guard let edge = regions.sideEdge, regions.sideWidth > 0 else { return nil }
    self.edge = edge
    width = regions.sideWidth
    center = regions.sideCenter > 0 ? regions.sideCenter : regions.sideWidth / 2
    self.holdsAllControls = holdsAllControls
    controlsTop = max(0, regions.sideTop - insets.top)
    controlsBottom = max(0, regions.sideBottom - insets.bottom)
  }
  init(rightColumnHoldingAllControls holdsAllControls: Bool) {
    edge = .trailing
    width = Self.rightColumnWidth
    center = width / 2
    self.holdsAllControls = holdsAllControls
    controlsTop = Self.topBarPadding
    controlsBottom = 0
    contentInset = width
  }
}

/// Places screen controls in a top bar, or in the side region when there is
/// one. Content keeps the safe area, so it stays clear of that region.
struct SideChromeBar<Top: View, Side: View>: ViewModifier {
  @Environment(\.sideChrome) private var chrome
  @Environment(\.topBarClearance) private var clearance
  /// Without one, the screen draws its own top bar.
  var top: Top?
  var side: Side
  func body(content: Content) -> some View {
    if let chrome {
      // Without a top bar, content still starts level with the clock.
      content.safeAreaPadding(.top, top == nil ? 0 : clearance)
        .overlay(alignment: chrome.edge == .trailing ? .topTrailing : .topLeading) {
          // Centered where iOS centers bar controls, under the status bar's items.
          let shift = chrome.contentInset > 0 ? 0 : chrome.width + chrome.width / 2 - chrome.center
          side.environment(\.nativeRailControl, true)
            .padding(.horizontal, 4).frame(width: max(52, chrome.width))
            .padding(.top, chrome.controlsTop)
            .padding(.bottom, chrome.controlsBottom + 8)
            .frame(maxHeight: .infinity, alignment: .top)
            .offset(x: chrome.edge == .trailing ? shift : -shift)
        }
    } else if let top {
      content.fadingTopBar { top }
    } else {
      content
    }
  }
}

/// A row the first bot's chat zooms out of, drawn over the list's own color.
private struct ZoomSource: ViewModifier {
  @Environment(\.canvasColor) private var canvas
  @Environment(\.opensConversationsInPlace) private var inPlace
  var id: String
  var namespace: Namespace.ID
  func body(content: Content) -> some View {
    // Beside a chat nothing zooms, and the source's fill would cover the selection.
    if inPlace {
      content
    } else {
      content.matchedTransitionSource(id: id, in: namespace) { source in
        source.background(canvas).clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
      }
    }
  }
}

/// Top padding for a top bar plus any clearance the screen needs above it.
struct TopBarClearance: ViewModifier {
  @Environment(\.topBarClearance) private var clearance
  var base: CGFloat
  init(_ base: CGFloat) { self.base = base }
  func body(content: Content) -> some View { content.padding(.top, base + clearance) }
}

/// The chat's leading header button when the chat shares the window with the
/// conversation list. Without one the chat shows Back.
struct ChatLeadingControl {
  var title: String
  var external = false
  var action: @MainActor () -> Void
}
extension EnvironmentValues {
  @Entry var botVoicePresentation: UUID?
  @Entry var chatLeadingControl: ChatLeadingControl?
  @Entry var leadingChatTitle = false
  @Entry var conversationListVisible = false
  @Entry var topBarTrailingInset: CGFloat = 0
  /// Conversation links select the chat beside the list instead of pushing it.
  @Entry var opensConversationsInPlace = false
  /// The side region holding the status bar, when controls belong there.
  @Entry var sideChrome: SideChrome?
}

/// Pushes a conversation over the list on narrow screens and opens it beside the
/// list on wide ones, marking the open conversation.
private struct ConversationLink<Label: View>: View {
  @Environment(AppStore.self) private var store
  @Environment(\.opensConversationsInPlace) private var inPlace
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let id: String
  var isSidebar = false
  var highlightsSelection = true
  @ViewBuilder var label: Label
  private var selected: Bool { highlightsSelection && store.navigation.last == id }
  var body: some View {
    if inPlace {
      Button {
        guard store.navigation.last != id else { return }
        NativeHaptics.play(.light, source: "conversation.select")
        Task { await store.open(id) }
      } label: {
        label.background {
          RoundedRectangle(cornerRadius: isSidebar ? SidebarMetrics.selectionRadius : 18)
            .fill(NativePalette.sidebarSelection)
            .padding(.horizontal, isSidebar
              ? SidebarMetrics.selectionInset - SidebarMetrics.rowLeading : -10)
            .padding(.vertical, isSidebar ? SidebarMetrics.selectionVerticalInset : 0)
            .opacity(selected ? 1 : 0)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: selected)
        }
      }.buttonStyle(ConversationSelectionButtonStyle(isSidebar: isSidebar))
        .accessibilityAddTraits(store.navigation.last == id ? .isSelected : [])
    } else {
      NavigationLink(value: id) { label }.buttonStyle(.borderless)
        .simultaneousGesture(TapGesture().onEnded {
          NativeHaptics.play(.light, source: "conversation.select")
        })
    }
  }
}

/// A short dim on touch, followed by a gentle release. The highlight fades at
/// its own row so rapid selections never slide a card through unrelated bots.
private struct ConversationSelectionButtonStyle: ButtonStyle {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var isSidebar: Bool
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .opacity(configuration.isPressed ? 0.65 : 1)
      .animation(reduceMotion || !isSidebar ? nil : .easeOut(duration: 0.18), value: configuration.isPressed)
  }
}

struct ChannelRow: View {
  @Environment(AppStore.self) private var store
  let channel: Channel
  var isSidebar = false
  private var last: Message? { store.latestMessage(channel.id) }
  private var unread: Bool { store.isUnread(channel) }
  var body: some View {
    HStack(spacing: isSidebar ? SidebarMetrics.avatarGap : 16) {
      ChannelAvatar(
        channel: channel, size: isSidebar ? SidebarMetrics.avatarSize : 46,
        artworkScale: isSidebar ? SidebarMetrics.avatarArtworkScale : 1)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          Text(channel.name).font(isSidebar ? .system(size: 18, weight: .medium) : .body.weight(.medium)).foregroundStyle(NativePalette.text)
            .lineLimit(1)
          if channel.showsGroupLabel {
            Text("Group").font(.system(size: 12)).foregroundStyle(NativePalette.muted)
              .padding(.horizontal, 6).padding(.vertical, 1)
              .background(NativePalette.text.opacity(0.07), in: RoundedRectangle(cornerRadius: 4))
              .layoutPriority(1)
          }
          Spacer(minLength: 8)
          if let date = last?.date {
            Text(dateLabel(date)).font(.system(size: 13)).foregroundStyle(NativePalette.faint)
          }
        }
        HStack {
          if last?.isAttachmentOnly == true {
            Image(systemName: "paperclip").font(.system(size: 13))
          }
          Text(preview).font(.system(size: 15)).lineLimit(1).frame(
            maxWidth: .infinity, alignment: .leading)
          if unread { Circle().fill(NativePalette.link).frame(width: 10, height: 10) }
        }.foregroundStyle(NativePalette.muted)
      }
    }.frame(minHeight: isSidebar ? SidebarMetrics.rowHeight : 80).contentShape(Rectangle()).accessibilityElement(children: .combine)
  }
  var preview: String {
    if !store.activeRuns(channel.id).isEmpty { return "Working…" }
    if let last { return last.previewText }
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
      ? "h:mm a" : (recent > 0 && recent < 7 ? "EEEE" : (isSidebar ? "MMM d" : "M/d/yy"))
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
  @State private var creationFailure: String?
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
      .background { TopFailureBanner(message: creationFailure).frame(width: 0, height: 0) }
      .onChange(of: name) { _, _ in creationFailure = nil }
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
    creationFailure = nil
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
    do {
      let result = try await store.request(
        group ? "/api/v0/channels" : "/api/v0/bots", method: "POST", body: body)
      await store.refresh(quiet: true)
      NativeHaptics.play(.success, source: "conversation.create")
      let id = group ? result["id"].string : result["dmChannelId"].string
      if !id.isEmpty { onCreated(id) }
    } catch {
      guard !UserFacingError.isCancelled(error) else { return }
      creationFailure = group
        ? "Could not create the group. Please try again."
        : "Could not create the Bot. Please try again."
      NativeHaptics.failure(error, source: "conversation.create")
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
        if loading { LoadingOrb(label: "Searching").padding() }
        if let failure {
          if failure == "Search unavailable" {
            VStack(spacing: 18) {
              Image(systemName: "magnifyingglass").font(.system(size: 32, weight: .regular))
              Text(failure).font(.title2.weight(.semibold))
                .accessibilityIdentifier("search-error")
              Text("Try again in a moment.").foregroundStyle(NativePalette.muted)
              Button("Try Again") { retryID += 1 }
                .accessibilityIdentifier("search-retry")
            }.frame(maxWidth: .infinity).padding(.vertical, 56)
          } else {
            InlineFailure(message: failure) { retryID += 1 }.padding()
          }
        }
        if searchQuery.isEmpty {
          ForEach(store.channels.filter { $0.kind != "agent_dm" }) { channel in
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
            failure = "Search unavailable"
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
/// its gestures. Allow pinning with a rightward swipe.
private struct ConversationSwipeRow<Content: View>: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.canvasColor) private var canvas
  let pinned: Bool
  let pin: () -> Void
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
      }.padding(.horizontal, 8)
      content().background(canvas).offset(x: offset)
        .gesture(
          MessageReplyGesture(
            allowsLeftward: true,
            onChanged: { translation in
              if !dragging {
                origin = offset
                dragging = true
              }
              offset = min(82, max(0, origin + translation.width))
            },
            onEnded: { _, velocity, cancelled in
              dragging = false
              let target: CGFloat = cancelled ? 0 : offset >= 40 ? 76 : 0
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
