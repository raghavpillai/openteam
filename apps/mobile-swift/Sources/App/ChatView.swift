import ImageIO
import PhotosUI
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

struct ChatView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let channel: Channel
  @State private var details = false
  @State private var duplicatedChannel: String?
  @State private var computerBot: Bot?
  @State private var timelineCache = ChatTimelineCache()
  @State private var modals = MessageModalPresenter()
  @State private var bottomVisible = true
  @State private var followsLatest = true
  @State private var scrollRequest: HistoryScrollRequest?
  @State private var exchange: BotExchangePeer?
  @State private var thread: Message?
  @State private var threadFocus: String?
  @State private var unreadBoundary: String?
  @State private var didCaptureBoundary = false
  @State private var didPositionHistory = false
  @State private var historyAvailable = false
  @State private var requestedInitialHistory = false
  private var hasLater: Bool { store.historyWindows[channel.id]?.hasLater == true }
  private var showsLatestButton: Bool {
    didPositionHistory && (hasLater || (!bottomVisible && !followsLatest))
  }
  var body: some View {
    let timeline = timelineCache.project(store.visibleMessages(channel.id))
    let rows = timelineCache.present(timeline, pending: pendingMessages, animateNew: didPositionHistory)
    ZStack {
      if historyAvailable {
        NativeMessageList(
          items: nativeRows(rows, timeline: timeline),
          initialTarget: store.focusedMessage ?? "bottom", request: scrollRequest,
          onPositioned: {
            didPositionHistory = true
            if let id = store.focusedMessage { focus(id) }
            else if !hasLater { Task { await store.markRead(channel.id) } }
          },
          onScroll: { bottom, following in
            bottomVisible = bottom
            followsLatest = following
            if bottom && following && !hasLater { Task { await store.markRead(channel.id) } }
          }
        )
        .opacity(didPositionHistory ? 1 : 0)
        .allowsHitTesting(didPositionHistory)
        .accessibilityHidden(!didPositionHistory)
        .overlay(alignment: .bottomTrailing) { latestButton }
      }
      if !didPositionHistory {
        ProgressView().controlSize(.regular).accessibilityLabel("Loading messages")
          .accessibilityIdentifier("chat-loading").frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .onChange(of: store.busy.contains("history-" + channel.id)) { _, busy in
      if requestedInitialHistory && !busy { historyAvailable = true }
    }
    .onChange(of: store.focusedMessage) { _, id in
      if didPositionHistory, let id, thread == nil { focus(id) }
    }
    .onChange(of: store.state.outbox.count) { old, new in
      if new > old { Task { await jumpToLatest() } }
    }
    .task(id: channel.id) {
      store.activeChannel = channel.id
      if !didCaptureBoundary {
        if let read = channel.notificationState?["lastReadSequence"].string, !read.isEmpty {
          unreadBoundary = store.messages(channel.id).first { !$0.isUser && MessageMerge.less(read, $0.sequence) }?.id
        }
        didCaptureBoundary = true
      }
      if store.histories[channel.id] != nil { historyAvailable = true }
      await store.loadHistory(channel.id)
      guard !Task.isCancelled else { return }
      requestedInitialHistory = true
      if !store.busy.contains("history-" + channel.id) { historyAvailable = true }
      if store.focusedRoutine != nil { details = true }
    }
    .onDisappear {
      store.flushPersistence()
      if store.activeChannel == channel.id { store.activeChannel = nil }
    }
    .nativeCanvas()
    .chatFloatingBars(top: { header }, bottom: { ComposerView(channel: channel).disabled(!didPositionHistory) })
    .toolbar(.hidden, for: .navigationBar).background(NativeBackGesture().frame(width: 0, height: 0))
    .navigationDestination(isPresented: $details) {
      ConversationDetails(channelID: channel.id, onDuplicate: { duplicatedChannel = $0 })
    }
    .navigationDestination(item: $exchange) { peer in BotExchangeView(channel: channel, peer: peer) }
    .onChange(of: details) { _, presented in
      if !presented, let id = duplicatedChannel {
        duplicatedChannel = nil
        Task { await store.open(id) }
      }
    }
    .messageModalHost(modals)
    .fullScreenCover(item: $computerBot) { bot in ComputerView(bot: bot) }
    .sheet(item: $thread) { message in
      ThreadView(root: message, channel: channel, initialFocus: threadFocus).referenceSheet()
        .onDisappear { threadFocus = nil }
    }
  }
  private func nativeRows(_ rows: [MessagePresentation.Row], timeline: MessageTimeline) -> [NativeHistoryItem] {
    var result: [NativeHistoryItem] = []
    let busy = store.busy.contains("history-" + channel.id)
    if store.histories[channel.id]?.hasMore == true {
      result.append(NativeHistoryItem(id: "earlier", scrollID: "earlier", version: busy.hashValue) {
        AnyView(Button("Load earlier messages") {
          Task { await store.loadHistory(channel.id, older: true) }
        }.font(.footnote).frame(maxWidth: .infinity).padding(14).disabled(busy))
      })
    }
    for row in rows {
      var hash = Hasher()
      hash.combine(row.timestamp)
      hash.combine(row.groupsWithPrevious)
      hash.combine(unreadBoundary == row.scrollID)
      switch row.content {
      case .confirmed(let entry):
        hash.combine(entry.message)
        hash.combine(timeline.replyCounts[entry.id] ?? 0)
      case .pending(let pending):
        hash.combine(pending.failure)
        hash.combine(pending.input.content)
        hash.combine(pending.input.attachments)
        hash.combine(pending.stagedFiles?.count)
        hash.combine(store.online)
      }
      result.append(NativeHistoryItem(id: row.id, scrollID: row.scrollID, version: hash.finalize(),
        anchorToBottom: row.timestamp != nil) {
        AnyView(MessageArrival(animate: timelineCache.consumeArrival(row), isUser: row.isUser) {
          timelineRow(row, replies: timeline.replyCounts[row.scrollID] ?? 0)
        }.padding(.horizontal, 16)
          .padding(.top, row.id == rows.first?.id ? 14 : row.groupsWithPrevious ? 8 : 12)
          .environment(store).environment(modals))
      })
    }
    if hasLater {
      let busy = store.busy.contains("later-" + channel.id)
      result.append(NativeHistoryItem(id: "later", scrollID: "later", version: busy.hashValue) {
        AnyView(Button("Load later messages") { Task { await store.loadLater(channel.id) } }
          .font(.footnote).frame(maxWidth: .infinity).padding(14).disabled(busy))
      })
    }
    for approval in store.approvals(channel) {
      result.append(NativeHistoryItem(id: "approval-" + approval.id, scrollID: approval.id,
        version: (try? JSON.encode(approval).hashValue) ?? 0) {
        AnyView(ApprovalCard(approval: approval).padding(.horizontal, 16).padding(.top, 12).environment(store).environment(modals))
      })
    }
    result.append(NativeHistoryItem(id: "bottom", scrollID: "bottom", version: hasLater.hashValue) {
      AnyView(ChatActivityFooter(channel: channel, showsActivity: !hasLater).environment(store).environment(modals))
    })
    return result
  }
  private func timelineRow(_ row: MessagePresentation.Row, replies: Int) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      if let date = row.timestamp {
        Text(timestamp(date)).font(.system(size: 13)).foregroundStyle(NativePalette.chatFaint)
          .frame(maxWidth: .infinity).padding(.top, 14).padding(.bottom, 2)
      }
      switch row.content {
      case .confirmed(let entry):
        let message = entry.message
        if unreadBoundary == message.id {
          HStack(spacing: 10) {
            NativePalette.link.opacity(0.55).frame(height: 0.5)
            Text("NEW").font(.system(size: 10, weight: .semibold)).tracking(1).foregroundStyle(NativePalette.link)
            NativePalette.link.opacity(0.55).frame(height: 0.5)
          }.padding(.vertical, 6).accessibilityLabel("New messages")
        }
        if message.metadata["event"]["type"].string == "name-changed" {
          Label("Renamed to " + message.metadata["event"]["to"].string, systemImage: "pencil")
            .font(.system(size: 12)).foregroundStyle(NativePalette.muted).frame(maxWidth: .infinity)
        } else {
          MessageRow(message: message, channel: channel, onReply: { reply(message) },
            onThread: { thread = message }, threadReplyCount: replies,
            onExchange: { exchange = $0 }, onRoutine: { store.focusedRoutine = $0; details = true })
        }
      case .pending(let pending): PendingMessageView(pending: pending)
      }
    }
  }
  private var latestButton: some View {
    ZStack {
      if showsLatestButton {
        Button {
          NativeHaptics.play(.selection, source: "chat.latest-button")
          Task { await jumpToLatest() }
        } label: {
          Image(systemName: "chevron.down").font(.system(size: 16, weight: .medium))
            .frame(width: 36, height: 36).nativeChatGlass().contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel("Latest messages")
          .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 8)).combined(with: .scale(scale: 0.9)))
      }
    }.frame(width: 36, height: 36).padding(.trailing, 30).padding(.bottom, 12)
      .allowsHitTesting(showsLatestButton)
      .animation(.easeInOut(duration: reduceMotion ? 0.15 : 0.22), value: showsLatestButton)
  }
  private var pendingMessages: [PendingSend] {
    store.state.outbox.filter { $0.channelId == channel.id && $0.input.isFork != true }
  }
  private func jumpToLatest() async {
    if hasLater, !(await store.loadLatest(channel.id)) { return }
    followsLatest = true
    scrollRequest = HistoryScrollRequest(id: "bottom")
  }
  private func focus(_ id: String) {
    followsLatest = false
    let message = store.messages(channel.id).first(where: { $0.id == id })
    if let message, var peer = BotExchangePeer(message.metadata) {
      peer.focusedMessageID = id
      exchange = peer
    } else if let message, message.metadata["branched"].bool {
      if let root = ThreadProjection.root(for: message, in: store.messages(channel.id)) {
        threadFocus = id
        thread = root
      } else { store.error = "The start of this thread is unavailable. Load earlier messages and try again." }
    } else { scrollRequest = HistoryScrollRequest(id: id, animated: false) }
    store.focusedMessage = nil
  }
  var header: some View {
    HStack(spacing: 8) {
      ChatChromeButton(title: "Back", symbol: "chevron.left", symbolSize: 18, symbolWeight: .regular) { dismiss() }
        .accessibilityIdentifier(
          "chat-back")
      Button {
        details = true
      } label: {
        HStack(spacing: 9) {
          ChannelAvatar(channel: channel, size: 27, groupStyle: .inline)
          Text(store.channel(channel.id)?.name ?? channel.name).font(.body.weight(.medium))
            .lineLimit(1)
        }.padding(.leading, 10).padding(.trailing, 14).frame(height: 44).nativeChatGlass()
      }.buttonStyle(.plain).accessibilityIdentifier("conversation-details")
        .frame(maxWidth: .infinity)
      // Equal side slots keep the pill on the screen's center, including groups
      // without a Computer action. Long names truncate within the middle slot.
      Group {
        if let bot = store.computerBot(for: channel) {
          ChatChromeButton(title: "Computer", symbol: "display", symbolSize: 16) {
            // Freeze the target for this presentation even if another bot replies.
            computerBot = bot
          }.accessibilityValue(bot.name)
        } else {
          Color.clear.accessibilityHidden(true)
        }
      }.frame(width: 44, height: 44)
    }.padding(.horizontal, 18).padding(.vertical, 6).foregroundStyle(NativePalette.text)
  }
  func timestamp(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "h:mm a"
    let day =
      Calendar.current.isDateInToday(date)
      ? "Today"
      : Calendar.current.isDateInYesterday(date)
        ? "Yesterday" : date.formatted(.dateTime.month(.abbreviated).day())
    return day + " " + formatter.string(from: date)
  }
  func reply(_ message: Message) {
    var draft = store.draft(channel.id)
    draft.replyTo = message.id
    draft.isFork = false
    store.saveDraft(draft, channel: channel.id)
  }
}

@MainActor private final class ChatTimelineCache {
  private var source: [Message] = []
  private var value = MessageTimeline([])
  private var presentation = MessagePresentation()
  private var animatedIDs: Set<String> = []
  func consumeArrival(_ row: MessagePresentation.Row) -> Bool {
    row.animatesArrival && animatedIDs.insert(row.id).inserted
  }
  var arrivalRevision: Int { presentation.arrivalRevision }
  func present(_ timeline: MessageTimeline, pending: [PendingSend], animateNew: Bool)
    -> [MessagePresentation.Row]
  {
    presentation.project(timeline, pending: pending, animateNew: animateNew)
  }
  func project(_ messages: [Message]) -> MessageTimeline {
    if source != messages {
      source = messages
      value = MessageTimeline(messages)
    }
    return value
  }
}

/// Keep this wrapper's identity across queued -> confirmed content. Only the new
/// bubble animates; loading history and updates to an existing bubble do not.
private struct MessageArrival<Content: View>: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var visible: Bool
  let isUser: Bool
  let content: Content
  init(animate: Bool, isUser: Bool, @ViewBuilder content: () -> Content) {
    _visible = State(initialValue: !animate)
    self.isUser = isUser
    self.content = content()
  }
  var body: some View {
    content
      .opacity(visible ? 1 : 0)
      .animation(
        .timingCurve(0.23, 1, 0.32, 1, duration: reduceMotion ? 0.12 : 0.132), value: visible
      )
      .offset(y: visible || reduceMotion ? 0 : 12)
      .scaleEffect(
        visible || reduceMotion ? 1 : 0.94, anchor: isUser ? .bottomTrailing : .bottomLeading
      )
      .animation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.24), value: visible)
      .onAppear { visible = true }
      // The arrival owns its fade; SwiftUI's implicit insertion fade otherwise
      // compounds it and keeps the bubble invisible until the scroll settles.
      .transition(.identity)
  }
}

struct MessageRow: View {
  @Environment(MessageModalPresenter.self) private var modals
  @AppStorage("accent") private var accent = "black"
  @Environment(AppStore.self) private var store
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let message: Message
  let channel: Channel
  var onReply: () -> Void
  var onThread: () -> Void
  var threadReplyCount = 0
  var onExchange: (BotExchangePeer) -> Void = { _ in }
  var onRoutine: (String) -> Void = { _ in }
  var viewOnly = false
  var speakerOverride: Bot?
  @State private var drag: CGFloat = 0
  @State private var swipeFeedback = ReplySwipeFeedback()
  private var speaker: Bot? {
    guard viewOnly || channel.isGroup, !message.isUser else { return nil }
    return speakerOverride ?? store.bots.first { $0.id == message.senderBotId }
  }
  var body: some View {
    Group {
      if !viewOnly, let peer = BotExchangePeer(message.metadata) {
        Button { onExchange(peer) } label: {
          HStack(spacing: 6) {
            Text(peer.incoming ? "Message from" : "Messaged")
            if let bot = store.bots.first(where: { $0.id == peer.id }) {
              MessageBotMark(bot: bot, size: 16)
            }
            Text(peer.name)
          }.font(.system(size: 13)).foregroundStyle(NativePalette.muted)
            .frame(maxWidth: .infinity).padding(.vertical, 4)
        }.buttonStyle(.plain).accessibilityLabel("Open exchange with " + peer.name)
          .accessibilityIdentifier("exchange-" + message.id)
      } else if !viewOnly, let routine = RoutineMessageEvent(message.metadata) {
        Button { onRoutine(routine.id) } label: {
          Label(routine.label, systemImage: "clock.arrow.circlepath")
            .font(.system(size: 13)).foregroundStyle(NativePalette.muted)
            .frame(maxWidth: .infinity).padding(.vertical, 4)
        }.buttonStyle(.plain).disabled(!routine.canOpen)
          .accessibilityIdentifier("routine-event-" + message.id)
      } else {
        bubble
      }
    }
  }
  private var bubble: some View {
    HStack(alignment: .bottom, spacing: 0) {
      if message.isUser { Spacer(minLength: 44) }
      if let speaker {
        Button { if !viewOnly { Task { await store.open(speaker.dmChannelId) } } } label: {
          MessageBotMark(bot: speaker, size: 22)
        }.buttonStyle(.plain).padding(.trailing, 7).padding(.bottom, 5)
          .accessibilityLabel("Open " + speaker.name + "’s chat")
          .allowsHitTesting(!viewOnly)
      }
      VStack(alignment: message.isUser ? .trailing : .leading, spacing: 5) {
        Group {
          if let speaker {
            Button { if !viewOnly { Task { await store.open(speaker.dmChannelId) } } } label: {
              Text(speaker.name).font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color(hex: speaker.color)).padding(.leading, 12)
            }.buttonStyle(.plain).allowsHitTesting(!viewOnly)
              .accessibilityIdentifier("speaker-" + message.id)
          }
          if let reply = message.replyTo {
            MessageReplyQuote(replyID: reply, channelID: channel.id, ownerID: message.id)
          }
          if !message.displayContent.isEmpty {
            Group {
              if RichMarkdownView.required(message.displayContent) {
                RichMarkdownView(source: message.displayContent, forceDark: message.isUser).frame(
                  maxWidth: .infinity)
              } else {
                BubbleTextLayout {
                  MarkdownText(source: message.displayContent).font(.body).lineSpacing(1.5)
                }
              }
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            .foregroundStyle(message.isUser ? Color.white : NativePalette.text)
            .background(
              message.isUser
                ? (accent == "blue" ? NativePalette.link : NativePalette.user)
                : NativePalette.assistant,
              in: RoundedRectangle(cornerRadius: 24))
          }
          ForEach(message.attachments, id: \.self) {
            AttachmentView(asset: $0, channelID: channel.id, messageID: message.id)
          }
          let replies = threadReplyCount
          if replies > 0 {
            Button(
              "\(replies) \(replies == 1 ? "reply" : "replies")",
              systemImage: "bubble.left.and.bubble.right", action: onThread
            )
            .font(.footnote).padding(.horizontal, 12).padding(.vertical, 4)
            .accessibilityIdentifier("thread-" + message.id)
          }
        }.highPriorityGesture(
          LongPressGesture(minimumDuration: 0.45).onEnded { _ in openActions() }
        )
        .gesture(replyGesture)
        // Native form controls own their taps, drags and text-selection holds.
        // A system context menu supplies message actions on the card itself.
        RichMessageCard(message: message).allowsHitTesting(!viewOnly).contextMenu {
          if !viewOnly {
          Button("Reply", systemImage: "arrow.uturn.backward") {
            NativeHaptics.play(.light, source: "message.reply-action")
            onReply()
          }
          Button("Start a thread", systemImage: "bubble.left.and.bubble.right", action: onThread)
          Button("Copy", systemImage: "square.on.square") {
            UIPasteboard.general.string = message.content
            NativeHaptics.play(.light, source: "message.copy")
          }
          Button("Mark as unread", systemImage: "bubble.left") { Task { await markUnread() } }
          }
        } preview: {
          RichMessageCard(message: message).environment(store).environment(modals)
            .allowsHitTesting(false)
            .onAppear { NativeHaptics.play(.medium, source: "message.long-press") }
        }
        let reactions = MessageReaction.project(message.metadata)
        if !reactions.isEmpty {
          HStack(spacing: 5) {
            ForEach(reactions) { reaction in
              Button { if !viewOnly { react(reaction.emoji) } } label: {
                HStack(spacing: 4) {
                  Text(reaction.emoji)
                  Text(String(reaction.count)).monospacedDigit()
                }.font(.caption).padding(.horizontal, 8).padding(.vertical, 5)
                  .background(reaction.isOwn ? NativePalette.link.opacity(0.15) : NativePalette.surface, in: Capsule())
                  .overlay(Capsule().stroke(reaction.isOwn ? NativePalette.link.opacity(0.6) : .clear, lineWidth: 1))
              }.buttonStyle(.plain).allowsHitTesting(!viewOnly)
                .accessibilityLabel("\(reaction.emoji), \(reaction.count) reactions")
                .accessibilityValue(reaction.isOwn ? "Selected" : "Not selected")
                .accessibilityIdentifier("reaction-" + message.id + "-" + reaction.emoji)
            }
          }
        }
      }.contentShape(Rectangle()).offset(x: drag)
        .accessibilityAction(named: "Message actions") { openActions() }
        .accessibilityAction(named: "Reply") {
          NativeHaptics.play(.light, source: "message.reply-action")
          onReply()
        }
      if !message.isUser { Spacer(minLength: 44) }
    }.accessibilityElement(children: .contain).accessibilityIdentifier("message-" + message.id)
      .background(alignment: .leading) {
        Image(systemName: "arrow.uturn.backward").font(.system(size: 16))
          .foregroundStyle(NativePalette.faint).padding(.leading, 18).opacity(drag > 5 ? 1 : 0)
      }
  }
  private func openActions() {
    guard modals.sheet == nil, !viewOnly else { return }
    NativeHaptics.play(.medium, source: "message.long-press")
    modals.sheet = .init(content: AnyView(MessageActionsView(
      onReply: {
        NativeHaptics.play(.light, source: "message.reply-action")
        modals.dismissSheet(then: onReply)
      },
      onThread: { modals.dismissSheet(then: onThread) },
      onUnread: {
        Task { await markUnread() }
        modals.dismissSheet()
      },
      onCopy: {
        UIPasteboard.general.string = message.content
        NativeHaptics.play(.light, source: "message.copy")
        modals.dismissSheet()
      },
      onReaction: { emoji in
        react(emoji)
        modals.dismissSheet()
      }
    ).presentationDetents([.height(340)]).presentationDragIndicator(.visible)
      .presentationCornerRadius(34).presentationBackground(NativePalette.background)))
  }
  private var replyGesture: MessageReplyGesture {
    MessageReplyGesture { translation in
      guard !viewOnly else { return }
      let distance = max(0, translation.width)
      drag = min(78, min(distance, 52) + max(0, distance - 52) * 0.28)
      if swipeFeedback.move(Double(distance)) {
        NativeHaptics.play(.light, source: "message.reply-swipe")
      }
    } onEnded: { translation, velocity, cancelled in
      guard !viewOnly else { return }
      if !cancelled {
        let result = swipeFeedback.release(Double(translation.width), velocity: Double(velocity))
        if result.open {
          if result.signal { NativeHaptics.play(.light, source: "message.reply-swipe") }
          onReply()
        }
      } else {
        swipeFeedback.reset()
      }
      withAnimation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.82)) {
        drag = 0
      }
    }
  }
  func react(_ emoji: String) {
    NativeHaptics.play(.selection, source: "message.reaction")
    Task {
      await store.mutate(
        "/api/v0/channel-messages/\(API.segment(message.id))/reaction",
        body: .object([
          "emoji": .string(emoji), "clientId": .string(UUID().uuidString),
          "timeZone": .string(TimeZone.current.identifier),
        ]))
    }
  }
  func markUnread() async {
    var next = store.sidebar
    next["unreadIds"] = .array(
      Array(Set(next["unreadIds"].array.map(\.string) + [channel.id])).map(JSON.string))
    if let result = await store.mutate("/api/v0/settings/sidebar", method: "PATCH", body: next) {
      store.sidebar = result
    }
  }
}

/// Use a full proposed line width for wrapped text, while keeping short bubbles intrinsic.
/// SwiftUI otherwise trims a multiline Text's frame to its longest rendered line.
struct BubbleTextLayout: Layout {
  @ScaledMetric(relativeTo: .body) private var lineHeight: CGFloat = 22
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let text = subviews.first else { return .zero }
    let natural = text.sizeThatFits(.unspecified)
    let width = min(proposal.width ?? natural.width, natural.width)
    let wrapped = text.sizeThatFits(ProposedViewSize(width: width, height: nil))
    // Text's natural first line is shorter than the reference's 22-point line box.
    // Reserve complete line boxes for wrapped bubbles as well as single lines.
    return CGSize(width: width, height: max(1, ceil(wrapped.height / lineHeight)) * lineHeight)
  }
  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) {
    guard let text = subviews.first else { return }
    let wrapped = text.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
    text.place(
      at: CGPoint(x: bounds.minX, y: bounds.minY + (bounds.height - wrapped.height) / 2),
      proposal: ProposedViewSize(width: bounds.width, height: wrapped.height))
  }
}

struct MessageActionsView: View {
  @State private var customReaction = false
  @State private var reaction = ""
  var onReply: () -> Void
  var onThread: () -> Void
  var onUnread: () -> Void
  var onCopy: () -> Void
  var onReaction: (String) -> Void
  var body: some View {
    VStack(spacing: 12) {
      LazyVGrid(
        columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 6), spacing: 14
      ) {
        ForEach(["👍", "👎", "❤️", "😂", "🎉", "😮", "🔥", "👀", "🙏", "😢", "💯"], id: \.self) { emoji in
          Button(emoji) { onReaction(emoji) }.font(.system(size: 22)).frame(width: 44, height: 44)
            .background(NativePalette.surface, in: Circle()).buttonStyle(.plain)
        }
        Button {
          customReaction = true
        } label: {
          Image(systemName: "face.smiling").font(.system(size: 20)).overlay(
            alignment: .bottomTrailing
          ) {
            Image(systemName: "plus").font(.system(size: 8, weight: .semibold)).padding(1)
              .background(NativePalette.surface, in: Circle()).offset(x: 3, y: 3)
          }.foregroundStyle(NativePalette.muted).frame(width: 44, height: 44).background(
            NativePalette.surface, in: Circle())
        }.buttonStyle(.plain).accessibilityLabel("Other reaction")
      }.padding(.top, 30).padding(.bottom, 4).padding(.horizontal, 8)
      VStack(spacing: 0) {
        action("Reply", "arrow.uturn.backward", onReply)
        NativePalette.separator.frame(height: 0.5).padding(.leading, 50)
        action("Start a thread", "bubble.left.and.bubble.right", onThread)
        NativePalette.separator.frame(height: 0.5).padding(.leading, 50)
        action("Mark as unread", "bubble.left", onUnread)
      }.background(NativePalette.surface, in: RoundedRectangle(cornerRadius: 16))
      action("Copy", "square.on.square", onCopy).background(
        NativePalette.surface, in: RoundedRectangle(cornerRadius: 16))
    }.padding(.horizontal, 16).frame(maxHeight: .infinity, alignment: .top).foregroundStyle(
      NativePalette.text
    )
    .alert("React to message", isPresented: $customReaction) {
      TextField("Emoji", text: $reaction)
      Button("React") { if let emoji = reaction.first { onReaction(String(emoji)) } }
      Button("Cancel", role: .cancel) {}
    }
  }
  func action(_ title: String, _ symbol: String, _ perform: @escaping () -> Void) -> some View {
    Button(action: perform) {
      HStack(spacing: 14) {
        Image(systemName: symbol).font(.system(size: 19)).frame(width: 22)
        Text(title).font(.body)
        Spacer()
      }.padding(.horizontal, 18).frame(height: 48).contentShape(Rectangle())
    }.buttonStyle(.plain)
  }
}
struct MarkdownText: View {
  let source: String
  func inline(_ block: String) -> AttributedString { MessageTextCache.inline(block) }
  var body: some View {
    if RichMarkdownView.required(source) {
      RichMarkdownView(source: source)
    } else {
      VStack(alignment: .leading, spacing: 10) {
        ForEach(Array(source.components(separatedBy: "```").enumerated()), id: \.offset) {
          i, block in
          if i % 2 == 1 {
            let code = block.components(separatedBy: "\n").dropFirst().joined(separator: "\n")
            ScrollView(.horizontal) {
              Text(code).font(.system(.footnote, design: .monospaced)).padding(12)
            }.background(NativePalette.code, in: RoundedRectangle(cornerRadius: 8))
          } else {
            Text(inline(block))
              .font(.body).fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    }
  }
}

@MainActor enum MessageTextCache {
  private static var values: [String: AttributedString] = [:]
  private static var order: [String] = []
  static func clear() { values = [:]; order = [] }
  static func inline(_ source: String) -> AttributedString {
    if let value = values[source] { return value }
    var value = (try? AttributedString(markdown: source,
      options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(source)
    for run in value.runs where run.inlinePresentationIntent?.contains(.code) == true {
      value[run.range].font = .system(size: 13, design: .monospaced)
    }
    values[source] = value
    order.append(source)
    if order.count > 256 { values.removeValue(forKey: order.removeFirst()) }
    return value
  }
}

struct MessageReplyQuote: View {
  @Environment(AppStore.self) private var store
  let replyID: String
  let channelID: String
  let ownerID: String
  var body: some View {
    let original = store.messages(channelID).first(where: { $0.id == replyID })
      Button {
        Task {
          if !store.messages(channelID).contains(where: { $0.id == replyID })
            || (!store.visibleMessages(channelID).contains(where: { $0.id == replyID })
              && original?.metadata["branched"].bool != true) {
            guard await store.loadContext(channelID, messageID: replyID) else { return }
          }
          store.focusedMessage = replyID
        }
      } label: {
        Label(
          original.map { $0.content.isEmpty ? "Attachment" : $0.content } ?? "View original message",
          systemImage: "arrowshape.turn.up.left"
        )
        .font(.caption).lineLimit(2).foregroundStyle(NativePalette.muted).padding(10)
        .background(NativePalette.surface, in: RoundedRectangle(cornerRadius: 14))
      }.buttonStyle(.plain).accessibilityIdentifier("reply-quote-" + ownerID)
  }
}

struct PendingMessageView: View {
  @AppStorage("accent") private var accent = "black"
  @Environment(AppStore.self) private var store
  let pending: PendingSend
  var body: some View {
    HStack(alignment: .bottom, spacing: 0) {
      Spacer(minLength: 44)
      VStack(alignment: .trailing, spacing: 5) {
        if let reply = pending.input.replyToMessageId {
          MessageReplyQuote(replyID: reply, channelID: pending.channelId, ownerID: pending.id)
        }
        if !pending.input.content.isEmpty {
          Group {
            if RichMarkdownView.required(pending.input.content) {
              RichMarkdownView(source: pending.input.content, forceDark: true).frame(
                maxWidth: .infinity)
            } else {
              BubbleTextLayout {
                MarkdownText(source: pending.input.content).font(.body).lineSpacing(1.5)
              }
            }
          }.padding(.horizontal, 14).padding(
            .vertical, 9
          ).foregroundStyle(.white).background(
            accent == "blue" ? NativePalette.link : NativePalette.user,
            in: RoundedRectangle(cornerRadius: 24))
        }
        if !(pending.stagedFiles ?? []).isEmpty || !pending.input.attachments.isEmpty {
          PendingAttachments(pending: pending)
        }
        if let failure = pending.failure {
          Text(failure).font(.caption).foregroundStyle(NativePalette.destructive)
          HStack {
            Button("Retry") { Task { await store.retry(pending.id) } }
            Button("Discard", role: .destructive) { store.discard(pending.id) }
          }.font(.caption)
        } else if !store.online {
          Text("Waiting for connection")
            .font(.caption).foregroundStyle(NativePalette.muted)
        }
      }
    }.id(pending.id)
  }
}

struct ThreadView: View {
  @Environment(\.dismiss) private var dismiss
  let root: Message
  let channel: Channel
  var initialFocus: String?
  @State private var path: [Message] = []
  var body: some View {
    NavigationStack(path: $path) {
      ThreadPage(root: root, channel: channel, initialFocus: initialFocus) { path.append($0) }
        .navigationDestination(for: Message.self) { message in
          ThreadPage(root: message, channel: channel) { path.append($0) }
        }
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
  }
}

struct ThreadPage: View {
  @Environment(AppStore.self) private var store
  let root: Message
  let channel: Channel
  var initialFocus: String?
  let onThread: (Message) -> Void
  @State private var timelineCache = ChatTimelineCache()
  @State private var modals = MessageModalPresenter()
  @State private var scrollRequest: HistoryScrollRequest?
  @State private var exchange: BotExchangePeer?
  @State private var details = false
  private var draftKey: String { channel.id + ":thread:" + root.id }
  private var messages: [Message] {
    ThreadProjection.messages(root: root, in: store.messages(channel.id))
  }
  var body: some View {
    NativeMessageList(items: rows, initialTarget: initialFocus ?? "bottom", request: scrollRequest)
      .messageModalHost(modals)
      .navigationTitle("Thread").navigationBarTitleDisplayMode(.inline)
      .safeAreaInset(edge: .bottom) {
        ComposerView(channel: channel, draftKey: draftKey, threadRootID: root.id)
      }
      .navigationDestination(item: $exchange) { BotExchangeView(channel: channel, peer: $0) }
      .navigationDestination(isPresented: $details) { ConversationDetails(channelID: channel.id) }
      .background(NativeBackGesture().frame(width: 0, height: 0))
      .onAppear { if store.draft(draftKey).replyTo == nil { setReply(root.id) } }
      .onChange(of: store.focusedMessage) { _, id in
        guard let id else { return }
        if messages.contains(where: { $0.id == id }) {
          scrollRequest = HistoryScrollRequest(id: id)
        } else if let message = store.messages(channel.id).first(where: { $0.id == id }),
          let target = ThreadProjection.root(for: message, in: store.messages(channel.id)) {
          onThread(target)
        }
        store.focusedMessage = nil
      }
  }
  private var rows: [NativeHistoryItem] {
    let replyCounts = timelineCache.project(store.messages(channel.id)).replyCounts
    var result: [NativeHistoryItem] = []
    if store.histories[channel.id]?.hasMore == true {
      let busy = store.busy.contains("history-" + channel.id)
      result.append(NativeHistoryItem(id: "earlier", scrollID: "earlier", version: busy.hashValue) {
        AnyView(Button("Load earlier replies") { Task { await store.loadHistory(channel.id, older: true) } }
          .font(.footnote).frame(maxWidth: .infinity).padding(14).disabled(busy))
      })
    }
    if store.histories[channel.id]?.threadContextTruncated == true {
      result.append(NativeHistoryItem(id: "truncated", scrollID: "truncated", version: 0) {
        AnyView(Text("Some earlier replies are not loaded yet.").font(.footnote)
          .foregroundStyle(NativePalette.muted).padding())
      })
    }
    for message in messages {
      let replies = replyCounts[message.id] ?? 0
      result.append(NativeHistoryItem(id: message.clientId ?? message.id, scrollID: message.id,
        version: message.hashValue ^ replies.hashValue) {
        AnyView(MessageRow(message: message, channel: channel, onReply: { setReply(message.id) },
          onThread: { if message.id != root.id { onThread(message) } else { setReply(root.id) } },
          threadReplyCount: replies, onExchange: { exchange = $0 },
          onRoutine: { store.focusedRoutine = $0; details = true })
          .padding(.horizontal, 16).padding(.top, 12).environment(store).environment(modals))
      })
    }
    let messageIDs = Set(messages.map(\.id))
    for pending in store.state.outbox.filter({
      $0.channelId == channel.id && $0.input.isFork == true && ($0.draftKey == draftKey
        || ($0.draftKey == nil && messageIDs.contains($0.input.replyToMessageId ?? "")))
    }) {
      result.append(NativeHistoryItem(id: pending.id, scrollID: pending.id,
        version: pending.failure.hashValue ^ pending.input.attachments.count.hashValue ^ store.online.hashValue) {
        AnyView(PendingMessageView(pending: pending).padding(.horizontal, 16).padding(.top, 12).environment(store).environment(modals))
      })
    }
    result.append(NativeHistoryItem(id: "bottom", scrollID: "bottom", version: 0) {
      AnyView(Color.clear.frame(height: 14))
    })
    return result
  }
  private func setReply(_ id: String) {
    var draft = store.draft(draftKey)
    draft.replyTo = id
    draft.isFork = true
    store.saveDraft(draft, channel: draftKey)
  }
}
