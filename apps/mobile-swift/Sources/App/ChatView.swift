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
  @State private var computer = false
  @State private var scrollFeedback = ChatScrollFeedback()
  @State private var timelineCache = ChatTimelineCache()
  @State private var bottomVisible = true
  @State private var followsLatest = true
  private var showsLatestButton: Bool { !bottomVisible && !followsLatest }
  @State private var paginationAnchor: ChatPageAnchor?
  @State private var thread: Message?
  @State private var threadFocus: String?
  @State private var unreadBoundary: String?
  @State private var didCaptureBoundary = false
  @State private var didPositionHistory = false
  @State private var activityVisible = false
  @State private var activityMode: RobotAvatarMode = .still
  private var activity: RobotAvatarMode? {
    let runs = store.activeRuns(channel.id)
    return runs.isEmpty
      ? nil : runs.contains { $0.status == "waiting_approval" } ? .idle : .thinking
  }
  private var rows: [Message] {
    store.messages(channel.id).filter { !$0.metadata["branched"].bool }
  }
  var body: some View {
    let timeline = timelineCache.project(store.messages(channel.id))
    let renderedRows = timelineCache.present(
      timeline, pending: pendingMessages, animateNew: didPositionHistory)
    GeometryReader { geometry in
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 12) {
            if store.histories[channel.id]?.hasMore == true {
              Button("Load earlier messages") {
                if let first = timeline.entries.first {
                  followsLatest = false
                  paginationAnchor = ChatPageAnchor(
                    id: first.id, frame: scrollFeedback.firstRowFrame,
                    timestampHeight: first.timestamp == nil
                      ? 0 : scrollFeedback.firstTimestampHeight + 12)
                }
                Task {
                  await store.loadHistory(channel.id, older: true)
                  if store.messages(channel.id).first?.id == paginationAnchor?.id {
                    paginationAnchor = nil
                  }
                }
              }.font(.footnote).frame(maxWidth: .infinity).disabled(
                store.busy.contains("history-" + channel.id))
            }
            ForEach(renderedRows) { row in
              MessageArrival(animate: row.animatesArrival, isUser: row.isUser) {
                VStack(alignment: .leading, spacing: 12) {
                  if let date = row.timestamp {
                    Text(timestamp(date)).font(.system(size: 13)).foregroundStyle(
                      NativePalette.chatFaint
                    )
                    .frame(maxWidth: .infinity).padding(.top, 14).padding(.bottom, 2)
                    .onGeometryChange(for: CGFloat.self) { geometry in
                      store.histories[channel.id]?.hasMore == true
                        && row.scrollID == timeline.entries.first?.id
                        ? geometry.size.height : 0
                    } action: { _, height in
                      if height > 0 { scrollFeedback.firstTimestampHeight = height }
                    }
                  }
                  switch row.content {
                  case .confirmed(let entry):
                    let message = entry.message
                    if unreadBoundary == message.id {
                      HStack(spacing: 10) {
                        NativePalette.link.opacity(0.55).frame(height: 0.5)
                        Text("NEW").font(.system(size: 10, weight: .semibold)).tracking(1)
                          .foregroundStyle(NativePalette.link)
                        NativePalette.link.opacity(0.55).frame(height: 0.5)
                      }.padding(.vertical, 6).accessibilityLabel("New messages")
                    }
                    if message.metadata["event"]["type"].string == "name-changed" {
                      Label(
                        "Renamed to " + message.metadata["event"]["to"].string,
                        systemImage: "pencil"
                      )
                      .font(.system(size: 12)).foregroundStyle(NativePalette.muted).frame(
                        maxWidth: .infinity)
                    } else {
                      MessageRow(
                        message: message, channel: channel, onReply: { reply(message) },
                        onThread: { thread = message },
                        threadReplyCount: timeline.replyCounts[message.id] ?? 0
                      )
                    }
                  case .pending(let pending):
                    PendingMessageView(pending: pending)
                  }
                }.id(row.scrollID)
                  .onGeometryChange(for: CGRect.self) { geometry in
                    store.histories[channel.id]?.hasMore == true
                      && row.scrollID == timeline.entries.first?.id
                      ? geometry.frame(in: .named("chat-history")) : .zero
                  } action: { _, frame in
                    if frame != .zero { scrollFeedback.firstRowFrame = frame }
                  }

              }
            }
            ForEach(store.approvals(channel)) { approval in ApprovalCard(approval: approval) }
            VStack(spacing: 0) {
              let runs = store.activeRuns(channel.id)
              if let bot = store.bots.first(where: { $0.id == runs.first?.botId })
                ?? store.bot(for: channel)
              {
                BotActivityRow(
                  bot: bot, mode: activityMode, visible: activityVisible)
              } else if !store.activeRuns(channel.id).isEmpty {
                ProgressView().frame(height: 54).padding(.bottom, 12)
              }
              Color.clear.frame(height: 1)
            }.padding(.bottom, 10).id("bottom")
          }
          .padding(.horizontal, 16).padding(.top, 14)
        }.coordinateSpace(name: "chat-history")
          .animation(
            reduceMotion ? nil : .easeInOut(duration: 0.32),
            value: timelineCache.arrivalRevision
          )
          .animation(
            reduceMotion
              ? nil
              : activityVisible ? .easeInOut(duration: 0.28) : .easeOut(duration: 0.24),
            value: activityVisible
          )
          .task(id: activity) {
            if let activity {
              activityMode = activity
              activityVisible = true
            } else {
              activityMode = .still
              if activityVisible && !reduceMotion {
                try? await Task.sleep(for: .seconds(RobotMotion.transitionDuration))
              }
              guard !Task.isCancelled else { return }
              activityVisible = false
            }
          }
          // Keep stable eager layout for variable-height text/WebKit content.
          // iOS 26 lazy stacks can loop layout when tall rows enter the viewport.
          .defaultScrollAnchor(.bottom, for: .initialOffset)
          .defaultScrollAnchor(.bottom, for: .alignment)
          .defaultScrollAnchor(followsLatest ? .bottom : nil, for: .sizeChanges)
          .onScrollPhaseChange { _, phase in
            if phase == .interacting {
              scrollFeedback.interacting = true
              followsLatest = false
              scrollFeedback.value.begin()
              if scrollFeedback.band == 2 {
                _ = scrollFeedback.value.observe(remaining: 24, scrollable: true)
              }
            } else if phase != .decelerating {
              scrollFeedback.interacting = false
              if scrollFeedback.band == 0 {
                followsLatest = true
                Task { await store.markRead(channel.id) }
              }
              scrollFeedback.value.end()
            }
          }
          .onScrollGeometryChange(for: Int.self) { geometry in
            let remaining = ScrollEdgeFeedback.remaining(
              content: Double(geometry.contentSize.height),
              viewport: Double(geometry.containerSize.height),
              offset: Double(geometry.contentOffset.y),
              topInset: Double(geometry.contentInsets.top))
            // Only the haptic thresholds matter. Observing every pixel used to
            // invalidate the whole history during each scroll animation frame.
            return geometry.contentSize.height <= geometry.containerSize.height
              ? -1
              : remaining <= 2 ? 0 : remaining < 24 ? 1 : 2
          } action: { _, band in
            scrollFeedback.band = band
            bottomVisible = band <= 0
            if bottomVisible, followsLatest { Task { await store.markRead(channel.id) } }
            if scrollFeedback.value.observe(
              remaining: band == 2 ? 24 : band == 1 ? 12 : 0,
              scrollable: band >= 0)
            {
              NativeHaptics.play(.selection, source: "chat.latest-scroll")
            }
          }
          .scrollDismissesKeyboard(.interactively)
          .scrollClipDisabled()
          .contentShape(Rectangle()).dismissKeyboardOnTap()
          .onChange(of: timeline.entries.last?.id) { _, _ in
            if followsLatest {
              Task { await store.markRead(channel.id) }
            }
          }
          .onChange(of: timeline.entries.first?.id) { _, _ in
            guard let anchor = paginationAnchor,
              let entry = timeline.entries.first(where: { $0.id == anchor.id })
            else { return }
            // A formerly first message can lose its date separator when older
            // messages arrive. Preserve the message's bottom, not that separator.
            let height = anchor.frame.height - (entry.timestamp == nil ? anchor.timestampHeight : 0)
            let available = geometry.size.height - height
            let fraction = available > 0 ? (anchor.frame.maxY - height) / available : 0
            proxy.scrollTo(anchor.id, anchor: UnitPoint(x: 0, y: fraction))
            paginationAnchor = nil
          }
          .onChange(of: store.state.outbox.count) { old, new in
            if new > old {
              let wasFollowing = followsLatest
              followsLatest = true
              if !wasFollowing {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.24)) {
                  proxy.scrollTo("bottom", anchor: .bottom)
                }
              }
            }
          }
          .onChange(of: store.focusedMessage) { _, id in
            if let id, thread == nil { focus(id, proxy: proxy) }
          }
          .overlay(alignment: .bottomTrailing) {
            ZStack {
              if showsLatestButton {
                Button {
                  NativeHaptics.play(.selection, source: "chat.latest-button")
                  followsLatest = true
                  withAnimation(reduceMotion ? nil : .default) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                  }
                } label: {
                  Image(systemName: "chevron.down").font(.system(size: 16, weight: .medium)).frame(
                    width: 36, height: 36
                  ).nativeChatGlass().contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel("Latest messages")
                  .transition(
                    reduceMotion
                      ? .opacity
                      : .opacity.combined(with: .offset(y: 8)).combined(with: .scale(scale: 0.9)))
              }
            }
            .frame(width: 36, height: 36)
            .padding(.trailing, 30).padding(.bottom, 12)
            .allowsHitTesting(showsLatestButton)
            // Animate the floating control without animating the message layout.
            .animation(.easeInOut(duration: reduceMotion ? 0.15 : 0.22), value: showsLatestButton)
          }
          .task(id: channel.id) {
            store.activeChannel = channel.id
            if !didCaptureBoundary {
              if let read = channel.notificationState?["lastReadSequence"].string, !read.isEmpty {
                unreadBoundary =
                  rows.first { !$0.isUser && MessageMerge.less(read, $0.sequence) }?.id
              }
              didCaptureBoundary = true
            }
            await store.loadHistory(channel.id)
            if !didPositionHistory {
              _ = timelineCache.present(
                timelineCache.project(store.messages(channel.id)),
                pending: pendingMessages, animateNew: false)
            }
            if let id = store.focusedMessage {
              focus(id, proxy: proxy)
            } else if !didPositionHistory {
              // Custom system bars settle their safe areas after the first layout.
              // Position once after history loads so the latest bubble stays above
              // the composer on smaller iPhones as well as large ones.
              proxy.scrollTo("bottom", anchor: .bottom)
            }
            didPositionHistory = true
            if store.focusedRoutine != nil { details = true }
          }
          .onDisappear {
            if store.activeChannel == channel.id { store.activeChannel = nil }
          }
      }
    }.nativeCanvas()
      .chatFloatingBars(top: { header }, bottom: { ComposerView(channel: channel) })
      .toolbar(.hidden, for: .navigationBar).background(
        NativeBackGesture().frame(width: 0, height: 0)
      )
      .navigationDestination(isPresented: $details) {
        ConversationDetails(channelID: channel.id, onDuplicate: { duplicatedChannel = $0 })
      }
      .onChange(of: details) { _, presented in
        if !presented, let id = duplicatedChannel {
          duplicatedChannel = nil
          Task { await store.open(id) }
        }
      }
      .fullScreenCover(isPresented: $computer) {
        if let bot = store.bot(for: channel) { ComputerView(bot: bot) }
      }
      .sheet(item: $thread) { message in
        ThreadView(root: message, channel: channel, initialFocus: threadFocus).referenceSheet()
          .onDisappear { threadFocus = nil }
      }
  }
  private var pendingMessages: [PendingSend] {
    store.state.outbox.filter { $0.channelId == channel.id && $0.input.isFork != true }
  }
  private func focus(_ id: String, proxy: ScrollViewProxy) {
    followsLatest = false
    if let message = store.messages(channel.id).first(where: { $0.id == id }),
      message.metadata["branched"].bool
    {
      if let root = ThreadProjection.root(for: message, in: store.messages(channel.id)) {
        threadFocus = id
        thread = root
      } else {
        store.error =
          "The start of this thread is unavailable. Load earlier messages and try again."
      }
    } else {
      proxy.scrollTo(id, anchor: .center)
    }
    didPositionHistory = true
    store.focusedMessage = nil
  }
  var header: some View {
    HStack(spacing: 8) {
      ChatChromeButton(title: "Back", symbol: "chevron.left", symbolSize: 16) { dismiss() }
        .accessibilityIdentifier(
          "chat-back")
      Button {
        details = true
      } label: {
        HStack(spacing: 9) {
          ChannelAvatar(channel: channel, size: 27)
          Text(store.channel(channel.id)?.name ?? channel.name).font(.body.weight(.medium))
            .lineLimit(1)
        }.padding(.leading, 10).padding(.trailing, 14).frame(height: 44).nativeChatGlass()
      }.buttonStyle(.plain).accessibilityIdentifier("conversation-details")
      Spacer(minLength: 4)
      if store.bot(for: channel) != nil {
        ChatChromeButton(title: "Computer", symbol: "display", symbolSize: 16) { computer = true }
      }
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

/// These caches are deliberately not observable: changing transient measurement
/// state must not trigger another layout of the conversation.
@MainActor private final class ChatScrollFeedback {
  var value = ScrollEdgeFeedback()
  var band = -1
  var interacting = false
  var firstRowFrame = CGRect.zero
  var firstTimestampHeight: CGFloat = 0
}
private struct ChatPageAnchor {
  let id: String
  let frame: CGRect
  let timestampHeight: CGFloat
}
@MainActor private final class ChatTimelineCache {
  private var source: [Message] = []
  private var value = MessageTimeline([])
  private var presentation = MessagePresentation()
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
  @AppStorage("accent") private var accent = "black"
  @Environment(AppStore.self) private var store
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let message: Message
  let channel: Channel
  var onReply: () -> Void
  var onThread: () -> Void
  var threadReplyCount = 0
  @State private var actions = false
  @State private var drag: CGFloat = 0
  @State private var swipeFeedback = ReplySwipeFeedback()
  private var directed: String {
    let from = message.metadata["fromAgent"]["name"].string
    let to = message.metadata["toAgent"]["name"].string
    return !from.isEmpty
      ? "\(from) → \(channel.name)" : !to.isEmpty ? "\(channel.name) → \(to)" : ""
  }
  var body: some View {
    HStack(alignment: .bottom, spacing: 0) {
      if message.isUser { Spacer(minLength: 44) }
      VStack(alignment: message.isUser ? .trailing : .leading, spacing: 5) {
        Group {
          if !directed.isEmpty {
            Label(directed, systemImage: "arrow.triangle.branch").font(.caption).foregroundStyle(
              NativePalette.muted)
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
        RichMessageCard(message: message).contextMenu {
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
        } preview: {
          RichMessageCard(message: message).environment(store)
            .allowsHitTesting(false)
            .onAppear { NativeHaptics.play(.medium, source: "message.long-press") }
        }
        if !message.metadata["reactions"].array.isEmpty {
          HStack {
            ForEach(
              Array(Set(message.metadata["reactions"].array.map { $0["emoji"].string })).sorted(),
              id: \.self
            ) { emoji in
              Button(emoji) { react(emoji) }.font(.caption).padding(6).background(
                NativePalette.link.opacity(0.1), in: Capsule())
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
      .sheet(isPresented: $actions) {
        MessageActionsView(
          onReply: {
            NativeHaptics.play(.light, source: "message.reply-action")
            actions = false
            onReply()
          },
          onThread: {
            actions = false
            onThread()
          },
          onUnread: {
            Task { await markUnread() }
            actions = false
          },
          onCopy: {
            UIPasteboard.general.string = message.content
            NativeHaptics.play(.light, source: "message.copy")
            actions = false
          },
          onReaction: { emoji in
            react(emoji)
            actions = false
          }
        )
        .presentationDetents([.height(340)]).presentationDragIndicator(.visible)
        .presentationCornerRadius(34).presentationBackground(NativePalette.background)
      }
  }
  private func openActions() {
    guard !actions else { return }
    NativeHaptics.play(.medium, source: "message.long-press")
    actions = true
  }
  private var replyGesture: MessageReplyGesture {
    MessageReplyGesture { translation in
      let distance = max(0, translation.width)
      drag = min(78, min(distance, 52) + max(0, distance - 52) * 0.28)
      if swipeFeedback.move(Double(distance)) {
        NativeHaptics.play(.light, source: "message.reply-swipe")
      }
    } onEnded: { translation, velocity, cancelled in
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
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let text = subviews.first else { return .zero }
    let natural = text.sizeThatFits(.unspecified)
    let width = min(proposal.width ?? natural.width, natural.width)
    let wrapped = text.sizeThatFits(ProposedViewSize(width: width, height: nil))
    return CGSize(width: width, height: max(22, wrapped.height))
  }
  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) {
    subviews.first?.place(
      at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
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
  func inline(_ block: String) -> AttributedString {
    var value =
      (try? AttributedString(
        markdown: block, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
      ?? AttributedString(block)
    for run in value.runs {
      if run.inlinePresentationIntent?.contains(.code) == true {
        value[run.range].font = .system(size: 13, design: .monospaced)
      }
    }
    return value
  }
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

struct MessageReplyQuote: View {
  @Environment(AppStore.self) private var store
  let replyID: String
  let channelID: String
  let ownerID: String
  var body: some View {
    if let original = store.messages(channelID).first(where: { $0.id == replyID }) {
      Button {
        store.focusedMessage = replyID
      } label: {
        Label(
          original.content.isEmpty ? "Attachment" : original.content,
          systemImage: "arrowshape.turn.up.left"
        )
        .font(.caption).lineLimit(2).foregroundStyle(NativePalette.muted).padding(10)
        .background(NativePalette.surface, in: RoundedRectangle(cornerRadius: 14))
      }.buttonStyle(.plain).accessibilityIdentifier("reply-quote-" + ownerID)
    }
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
          Text("Queued · offline")
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
  private var draftKey: String { channel.id + ":thread:" + root.id }
  private var messages: [Message] {
    ThreadProjection.messages(root: root, in: store.messages(channel.id))
  }
  var body: some View {
    let replyCounts = timelineCache.project(store.messages(channel.id)).replyCounts
    let messages = self.messages
    ScrollViewReader { proxy in
      ScrollView {
        VStack(spacing: 16) {
          if store.histories[channel.id]?.hasMore == true {
            Button("Load earlier replies") {
              Task { await store.loadHistory(channel.id, older: true) }
            }
            .disabled(store.busy.contains("history-" + channel.id))
          }
          if store.histories[channel.id]?.threadContextTruncated == true {
            Text("Some earlier replies are not loaded yet.").font(.footnote).foregroundStyle(
              NativePalette.muted)
          }
          ForEach(messages) { message in
            MessageRow(
              message: message, channel: channel, onReply: { setReply(message.id) },
              onThread: {
                if message.id != root.id { onThread(message) } else { setReply(root.id) }
              }, threadReplyCount: replyCounts[message.id] ?? 0
            ).id(message.id)

          }
          let messageIDs = Set(messages.map(\.id))
          ForEach(
            store.state.outbox.filter {
              $0.channelId == channel.id && $0.input.isFork == true
                && ($0.draftKey == draftKey
                  || ($0.draftKey == nil && messageIDs.contains($0.input.replyToMessageId ?? "")))
            }
          ) { PendingMessageView(pending: $0) }
        }.padding()
      }.scrollDismissesKeyboard(.interactively)
        .contentShape(Rectangle()).dismissKeyboardOnTap()
        .navigationTitle("Thread")
        .navigationBarTitleDisplayMode(
          .inline
        )
        .safeAreaInset(edge: .bottom) {
          ComposerView(channel: channel, draftKey: draftKey, threadRootID: root.id)
        }
        .background(NativeBackGesture().frame(width: 0, height: 0))
        .onAppear {
          if store.draft(draftKey).replyTo == nil { setReply(root.id) }
          if let initialFocus {
            proxy.scrollTo(initialFocus, anchor: .center)
          } else if let latest = messages.last {
            proxy.scrollTo(latest.id, anchor: .bottom)
          }
        }
        .onChange(of: store.focusedMessage) { _, id in
          guard let id else { return }
          if messages.contains(where: { $0.id == id }) {
            proxy.scrollTo(id, anchor: .center)
          } else if let message = store.messages(channel.id).first(where: { $0.id == id }),
            let target = ThreadProjection.root(for: message, in: store.messages(channel.id))
          {
            onThread(target)
          }
          store.focusedMessage = nil
        }
    }
  }
  private func setReply(_ id: String) {
    var draft = store.draft(draftKey)
    draft.replyTo = id
    draft.isFork = true
    store.saveDraft(draft, channel: draftKey)
  }
}
