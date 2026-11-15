import SwiftUI

/// What the person just did with a question on this device, shown before the server confirms it.
enum QuestionIntent: Equatable {
  case answer(String)
  case skip
}

/// What a question card remembers while it is on screen: the tap it is showing, its request, and
/// how far it has closed. It lives outside the view because the message list rebuilds row views
/// (sending a message reloads the table, and the same chat can be open in two scenes): a card
/// rebuilt part-way carries on from here instead of snapping to its end state, and a request
/// that finishes after its view is gone still reports to the card that replaced it.
@MainActor @Observable final class QuestionCardState {
  var pending: QuestionIntent?
  /// The single choice just tapped: its radio fills before the answer is shown as sent.
  var picked: String?
  var busy = false
  var failure: String?
  /// A retry is on its way: the last failure fades and folds away with the card.
  var failureStale = false
  var requestID = UUID().uuidString
  var lastAction = ""
  /// The card has closed (and stays closed while its outcome stands).
  var closed = false
  /// The list had already handed over the settled message when the card began to close.
  var settledBeforeClose = false
  /// The question has been shown open, so closing it is something to animate.
  var sawOpen = false
  var chipLanded = false
  /// The card has finished closing: the parts it melted away are dropped from the view tree.
  var tidy = false
  /// When a card closed from elsewhere started waiting for the list.
  @ObservationIgnored var waitingSince: Date?

  @ObservationIgnored private let key: String
  @ObservationIgnored private var viewers = 0
  @ObservationIgnored private var expiry: Task<Void, Never>?
  private static var live: [String: QuestionCardState] = [:]

  private init(key: String) { self.key = key }
  static func of(_ message: Message) -> QuestionCardState {
    let key = message.channelId + ":" + message.id
    if let state = live[key] { return state }
    let state = QuestionCardState(key: key)
    live[key] = state
    state.settle()
    return state
  }
  func attach() {
    viewers += 1
    expiry?.cancel()
  }
  func detach() {
    viewers -= 1
    settle()
  }
  /// Forgotten shortly after the last view goes, so a chat opened again later shows the
  /// question as it is, without replaying anything.
  func settle() {
    guard viewers <= 0, !busy else { return }
    expiry?.cancel()
    expiry = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(1.5)) } catch { return }
      guard let self, self.viewers <= 0, !self.busy, Self.live[self.key] === self else { return }
      Self.live[self.key] = nil
    }
  }
}

/// A bot's question: option tiles, an optional custom answer, and Skip.
///
/// The open card and its receipt are one view. Answering keeps the chosen tiles on screen and
/// turns them into the receipt rows while everything else melts away and the card closes around
/// them; Skip turns the Skip button into the "Skipped" chip. Both start on the tap, before the
/// server has answered, and reverse if it refuses.
///
/// The card closes by walking its own height down (`QuestionCloseLayout`), which the transcript
/// follows frame by frame. The request leaves once the card has closed: the confirmed message
/// makes the message list reconfigure the row, and a height change made during that is not
/// followed. For the same reason a question closed by a chat message or a newer question dims
/// at once but waits for the list to finish with the new message before it closes.
struct QuestionCard: View {
  @VoiceMotionPreference private var reduceMotion
  @Environment(AppStore.self) private var store
  @Environment(\.messageArrivesLive) private var arrivesLive
  let message: Message

  /// See `QuestionCardState`: what must outlive a rebuilt view.
  private var state: QuestionCardState { QuestionCardState.of(message) }
  @State private var openHeight: CGFloat?
  @State private var closedHeight: CGFloat?
  /// A question that has just arrived holds its tiles back for a frame, then lets them rise.
  @State private var staged = false
  @State private var born = Date()
  @State private var flight: QuestionChipFlight?
  @State private var chipFrame: CGRect?
  @State private var skipFrame = FrameBox()
  /// Where the last Skip flight left from, for flying back after it has landed.
  @State private var skipOrigin = CGRect.zero
  @FocusState private var customFocused: Bool

  private final class FrameBox { var rect = CGRect.zero }
  private nonisolated static let space = "question-card"

  /// Which options an answer names, and what is left over as a custom answer. Same rule as
  /// `WidgetAnswer.resolve`, keeping the options' places.
  private struct Chosen {
    var options: Set<Int> = []
    var custom = ""
    init(widget: JSON, response: String?) {
      guard let response else { return }
      let values = widget["multiSelect"].bool
        ? response.components(separatedBy: "\n").filter { !$0.isEmpty } : [response]
      var remaining = Set(values)
      for (index, option) in widget["options"].array.enumerated()
      where remaining.remove(QuestionCard.value(option)) != nil { options.insert(index) }
      custom = values.filter { remaining.contains($0) }.joined(separator: "\n")
    }
  }

  private var meta: JSON {
    store.questionMessages(message.channelId).first { $0.id == message.id }?.metadata ?? message.metadata
  }
  private var selected: Set<String> {
    Set(store.draft(message.channelId).widgetSelections?[message.id] ?? [])
  }
  private var customAnswer: String {
    store.draft(message.channelId).widgetCustomAnswers?[message.id] ?? ""
  }
  private nonisolated static func value(_ option: JSON) -> String {
    option["value"].string.isEmpty ? option["label"].string : option["value"].string
  }
  private static func settled(_ metadata: JSON) -> Bool {
    metadata["respondedValue"] != .null || metadata["widgetDismissed"].bool
  }
  /// Changes whenever something happens that makes the list update this transcript's rows.
  private var transcriptActivity: Int {
    var hash = Hasher()
    for send in store.state.outbox where send.channelId == message.channelId {
      hash.combine(send.id)
      hash.combine(send.failure)
      hash.combine(send.deliveryUnconfirmed)
    }
    hash.combine(store.activeSendID)
    hash.combine(store.checkingSendID)
    let messages = store.messages(message.channelId)
    hash.combine(messages.count)
    hash.combine(messages.last)
    return hash.finalize()
  }
  /// A multi-select answer: the selected options in order, then the custom text.
  private func composedAnswer(_ widget: JSON) -> String {
    let custom = customAnswer.trimmingCharacters(in: .whitespacesAndNewlines)
    let values = widget["multiSelect"].bool
      ? widget["options"].array.map(Self.value).filter(selected.contains) : []
    return (values + (custom.isEmpty ? [] : [custom])).joined(separator: "\n")
  }

  var body: some View {
    let meta = self.meta
    let widget = meta["widget"]
    let multi = widget["multiSelect"].bool
    let options = widget["options"].array
    let motion = !reduceMotion
    let modelAnswer: String? = { if case .string(let value) = meta["respondedValue"] { value } else { nil } }()
    let modelDismissed = meta["widgetDismissed"].bool
    let modelSettled = Self.settled(meta)
    // What the card shows: the server's word once it has spoken, the tap until then.
    let answer: String? = modelSettled ? modelAnswer : { if case .answer(let value) = state.pending { value } else { nil } }()
    let dismissed = modelSettled ? modelDismissed && meta["respondedValue"] == .null : state.pending == .skip
    /// The question is over: nothing on it can be pressed and the outcome shows.
    let going = modelSettled || state.pending != nil
    /// The card is laid out as its receipt. A tap settles it at once; an outcome that came from
    /// elsewhere settles it after `closed`, and one already settled when it came on screen is
    /// never shown open.
    let settled = state.pending != nil || (modelSettled && (state.closed || !state.sawOpen))
    // Skip's own flight is under way.
    let skipping = flight?.kind == .skip
    let chosen = Chosen(widget: widget, response: answer)
    let interactive = !going && !state.busy
      && !store.busy.contains("/api/v0/channel-messages/\(API.segment(message.id))/widget-response")
    let draft = composedAnswer(widget)
    let customKept = !chosen.custom.isEmpty
    // A card closing on screen keeps every part in its tree until it has closed: a view removed
    // mid-animation is redrawn from scratch for its transition, which would undo its melt.
    let live = !modelSettled || (state.sawOpen && !state.tidy)
    let rowCount = options.count + (widget["allowCustom"].bool ? 1 : 0)
    let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
    let waiting = modelSettled && !settled
    let activity = waiting ? transcriptActivity : 0
    let closing = motion
      ? QuestionMotion.settle.delay(QuestionMotion.seconds(skipping ? QuestionMotion.liftOff : QuestionMotion.lead))
      : nil

    QuestionCloseLayout(
      // A settled copy of the message arriving while the card closes means the list is
      // resizing the row from here on.
      listDriven: state.closed && !state.settledBeforeClose && Self.settled(message.metadata), settled: settled,
      openHeight: openHeight, closedHeight: closedHeight, amount: settled ? 1 : 0
    ) {
      VStack(alignment: .leading, spacing: 0) {
        if let failure = state.failure {
          InlineFailure(message: failure)
            .padding(.bottom, 12)
            .opacity(state.failureStale ? 0 : 1).accessibilityHidden(state.failureStale)
            .animation(motion ? QuestionMotion.quick : nil, value: state.failureStale)
            .modifier(QuestionFold(folded: state.failureStale && settled, gap: 0))
        }
        VStack(alignment: .leading, spacing: 0) {
          QuestionHeaderLayout(reserve: settled) {
            Text(widget["prompt"].string)
              .font(.body.weight(.medium))
              .foregroundStyle(going ? QuestionPalette.secondary : QuestionPalette.text)
              .fixedSize(horizontal: false, vertical: true)
              .animation(motion ? QuestionMotion.highlight : nil, value: going)
            // A refused skip keeps its chip while the blob gathers it back up.
            if dismissed || flight?.reversed != nil {
              QuestionChip(reason: modelDismissed ? meta["widgetDismissalReason"].string : "dismissed",
                messageID: message.id,
                resolved: (!state.sawOpen || state.chipLanded) && flight?.reversed == nil, motion: motion)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.space)) } action: { chipFrame = $0 }
                .accessibilityHidden(!modelDismissed)
                .transition(.identity)
            }
          }.frame(maxWidth: .infinity, alignment: .leading)
          // Parts the outcome leaves behind melt and fold away, and are removed afterwards.
          if live, !widget["helpText"].string.isEmpty {
            Text(widget["helpText"].string).font(.subheadline)
              .foregroundStyle(QuestionPalette.secondary)
              .fixedSize(horizontal: false, vertical: true)
              .modifier(QuestionMelt(gone: settled, fading: going,
                delay: Double(rowCount + 1) * QuestionMotion.meltStagger, motion: motion))
              .modifier(QuestionFold(folded: settled, gap: 3))
          }
          ForEach(Array(options.enumerated()), id: \.offset) { index, option in
            let kept = chosen.options.contains(index)
            if live || kept {
              let value = Self.value(option)
              let on = selected.contains(value) || state.picked == value
              // Receipt rows are numbered in the order they are shown.
              let place = chosen.options.filter { $0 < index }.count
              optionRow(option, multi: multi, phase: kept ? .sent : on ? .on : .off,
                receipt: settled, live: live, interactive: interactive, motion: motion,
                identifier: kept && modelSettled ? "widget-answer-\(message.id)-\(place)" : nil
              ) {
                if multi { toggle(value, options: options) } else {
                  state.picked = value
                  send(.answer(value), lead: QuestionMotion.pick)
                }
              }
              .modifier(QuestionMelt(gone: settled && !kept, fading: going && !kept,
                delay: Double(rowCount - index) * QuestionMotion.meltStagger, motion: motion))
              .modifier(QuestionArrival(staged: staged, index: index, motion: motion))
              .modifier(QuestionFold(folded: settled && !kept,
                gap: !settled ? (index == 0 ? 12 : 6) : place == 0 ? 12 : 8))
            }
          }
          if customKept || (live && widget["allowCustom"].bool) {
            customRow(multi: multi, kept: chosen.custom, receipt: settled,
              // A field that became the receipt stays, so its words never shift.
              editable: (!modelSettled || state.sawOpen) && widget["allowCustom"].bool,
              interactive: interactive, motion: motion,
              identifier: customKept && modelSettled ? "widget-answer-\(message.id)-\(chosen.options.count)" : nil)
              .modifier(QuestionMelt(gone: settled && !customKept, fading: going && !customKept,
                delay: QuestionMotion.meltStagger, motion: motion))
              .modifier(QuestionArrival(staged: staged, index: options.count, motion: motion))
              .modifier(QuestionFold(folded: settled && !customKept,
                gap: !settled ? (options.isEmpty ? 12 : 6) : chosen.options.isEmpty ? 12 : 8))
          }
          if live {
            footer(multi: multi, draft: draft, going: going, settled: settled, interactive: interactive,
              motion: motion)
              .modifier(QuestionArrival(staged: staged, index: rowCount, motion: motion))
              .modifier(QuestionFold(folded: settled, gap: 12))
          }
        }
        .padding(14)
        .overlay(alignment: .top) {
          if let flight {
            // The card's layout frame is already the closed one; the blob starts below it, so
            // the canvas reaches down to the pressed button. The card's shape still clips it.
            QuestionChipGoo(flight: flight, chip: chipFrame)
              .frame(height: max(flight.from.maxY + 24, chipFrame?.maxY ?? 0))
              // No transition: it would fade the blob in on the card's delayed closing animation.
              .transition(.identity)
          }
        }
        .background(NativePalette.surface, in: shape)
        .clipShape(shape)
        .overlay(shape.stroke(NativePalette.separator, lineWidth: 0.5))
        .coordinateSpace(.named(Self.space))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("widget-card-" + message.id)
      }
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
        if settled { closedHeight = height } else { openHeight = height }
      }
    }
    .animation(closing, value: settled)
    // Without motion nothing may animate, including a change that lands inside the message
    // list's own animated row update, which SwiftUI would otherwise inherit.
    .transaction { transaction in
      if !motion {
        transaction.animation = nil
        transaction.disablesAnimations = true
      }
    }
    .onAppear {
      // Only a row that arrives live stages its tiles; history rows never do.
      if arrivesLive, motion, !going, !staged, Date().timeIntervalSince(born) < 0.3 {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { staged = true }
        Task { @MainActor in
          try? await Task.sleep(for: .milliseconds(20))
          staged = false
        }
      }
      state.attach()
      if !modelSettled { state.sawOpen = true }
      // Rebuilt while its chip was on the way: bud it again rather than leave it unseen.
      if dismissed, state.sawOpen, !state.chipLanded, flight == nil {
        if motion { flight = QuestionChipFlight(kind: .bud) } else { state.chipLanded = true }
      }
    }
    .onDisappear { state.detach() }
    .onChange(of: selected) { _, _ in state.requestID = UUID().uuidString }
    .onChange(of: modelSettled) { _, settled in
      if settled { state.pending = nil } else {
        state.sawOpen = true
        state.waitingSince = nil
      }
    }
    .onChange(of: settled) { _, settled in
      state.closed = settled
      if !settled {
        state.settledBeforeClose = false
        state.tidy = false
      }
      // The tick lands with the receipt, once the card has closed around it.
      if settled, motion, state.sawOpen, !dismissed {
        Task { @MainActor in
          try? await Task.sleep(for: QuestionMotion.pause(0.22))
          landed()
        }
      }
    }
    .onChange(of: dismissed) { _, dismissed in
      if !dismissed {
        state.chipLanded = false
        if flight?.reversed == nil { flight = nil }
      } else if !skipping {
        // No button was pressed here: the chip buds out of the card's edge.
        if motion, state.sawOpen { flight = QuestionChipFlight(kind: .bud) } else { state.chipLanded = true }
      }
    }
    // Closed from elsewhere: the card dims now and closes once the list has finished with
    // whatever closed it (a sent message and its delivery, a newer question, a remote answer).
    // The list does not follow a height that changes while it animates another row.
    .task(id: waiting ? activity : nil) {
      guard waiting else { return }
      let state = self.state
      let since = state.waitingSince ?? Date()
      state.waitingSince = since
      let left = QuestionMotion.quietCap - Date().timeIntervalSince(since)
      let quiet = store.messages(message.channelId).last?.isUser == true
        ? QuestionMotion.quiet : QuestionMotion.quietAfterArrival
      do { try await Task.sleep(for: .seconds(max(0, min(quiet, left)))) } catch { return }
      state.waitingSince = nil
      // Read now, not from this task's copy of the view: the settled message may have been
      // handed over while it slept.
      let current = store.messages(message.channelId).first { $0.id == message.id } ?? message
      state.settledBeforeClose = Self.settled(current.metadata)
      state.closed = true
    }
    .task(id: settled) {
      guard settled, !state.tidy else { return }
      do { try await Task.sleep(for: QuestionMotion.pause(0.6)) } catch { return }
      state.tidy = true
    }
    .task(id: flight.map { [$0.started, $0.reversed ?? .distantPast] }) {
      guard let flying = flight else { return }
      do {
        if flying.reversed != nil {
          try await Task.sleep(for: QuestionMotion.pause(flying.reversedTime / QuestionChipFlight.reverseSpeed))
          flight = nil
          return
        }
        try await Task.sleep(for: QuestionMotion.pause(flying.resolve))
        state.chipLanded = true
        landed()
        try await Task.sleep(for: QuestionMotion.pause(flying.end - flying.resolve + 0.03))
        flight = nil
      } catch {}
    }
  }

  /// The receipt or the chip is in place.
  private func landed() {
    NativeHaptics.play(.soft, intensity: 0.7, source: "widget.settle")
  }

  private func optionRow(
    _ option: JSON, multi: Bool, phase: QuestionControl.Phase, receipt: Bool, live: Bool, interactive: Bool,
    motion: Bool, identifier: String?, action: @escaping () -> Void
  ) -> some View {
    let label = option["label"].string, description = option["description"].string
    return Button(action: action) {
      HStack(alignment: receipt ? .top : .center, spacing: receipt ? 10 : 11) {
        QuestionControl(multi: multi, phase: phase, motion: motion)
        VStack(alignment: .leading, spacing: 0) {
          Text(label).font(.body)
            .foregroundStyle(option["style"].string == "danger" && phase != .sent
              ? NativePalette.widgetDanger : QuestionPalette.text)
            .padding(.top, receipt ? 1 : 0)
          if live, !description.isEmpty {
            // A receipt keeps only the label.
            Text(description).font(.subheadline).foregroundStyle(QuestionPalette.secondary)
              .opacity(phase == .sent ? 0 : 1)
              .animation(motion ? QuestionMotion.melt : nil, value: phase == .sent)
              .modifier(QuestionFold(folded: receipt, gap: 2))
              .accessibilityHidden(true)
          }
        }.fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
      }.modifier(QuestionTile(on: phase != .off, receipt: receipt, motion: motion))
    }.buttonStyle(QuestionPressStyle(motion: motion))
      .allowsHitTesting(interactive)
      .accessibilityLabel(label)
      .accessibilityValue(phase == .off ? "" : "Selected")
      // A receipt row is a statement, not something to press.
      .accessibilityRemoveTraits(receipt || phase == .sent ? .isButton : [])
      .accessibilityIdentifier(identifier ?? "")
  }

  private func customRow(
    multi: Bool, kept: String, receipt: Bool, editable: Bool, interactive: Bool, motion: Bool, identifier: String?
  ) -> some View {
    let sent = !kept.isEmpty
    let typed = customAnswer.trimmingCharacters(in: .whitespacesAndNewlines)
    // The field stays when its own text is the answer, so the words don't move as it is sent.
    let field = editable && (!sent || kept == typed)
    return HStack(alignment: receipt ? .top : .center, spacing: receipt ? 10 : 11) {
      ZStack {
        // The pencil turns into the receipt's check.
        Image(systemName: "pencil").font(.system(size: 15, weight: .medium))
          .foregroundStyle(QuestionPalette.secondary)
          .scaleEffect(sent ? 0.3 : 1).opacity(sent ? 0 : 1)
          .animation(motion ? QuestionMotion.receipt : nil, value: sent)
        QuestionControl(multi: true, phase: sent ? .sent : .off, ring: false, motion: motion)
      }.frame(width: 22, height: 22).accessibilityHidden(true)
      if !field {
        Text(kept).font(.body).foregroundStyle(QuestionPalette.text)
          .padding(.top, receipt ? 1 : 0)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          .transition(.identity)
      } else {
        TextField("Something else", text: Binding(get: { customAnswer }, set: { value in
          var draft = store.draft(message.channelId)
          if draft.widgetCustomAnswers == nil { draft.widgetCustomAnswers = [:] }
          draft.widgetCustomAnswers?[message.id] = value
          store.saveDraft(draft, channel: message.channelId)
          state.requestID = UUID().uuidString
        }), axis: .vertical)
          .font(.body).foregroundStyle(QuestionPalette.text).tint(QuestionPalette.text)
          .focused($customFocused)
          .padding(.top, receipt ? 1 : 0)
          .allowsHitTesting(!sent && interactive)
          .accessibilityIdentifier(sent ? "" : "widget-custom-" + message.id)
          .transition(.identity)
        if !multi {
          // Always laid out, so the text never rewraps when the button buds out of the edge.
          Button { send(.answer(typed)) } label: {
            Image(systemName: "arrow.up").font(.system(size: 13, weight: .bold))
              .foregroundStyle(QuestionPalette.inverted).frame(width: 26, height: 26)
              .background(QuestionPalette.text, in: Circle())
              .contentShape(Circle().inset(by: -9))
          }.buttonStyle(QuestionPressStyle(motion: motion, scale: 0.9))
            .scaleEffect(x: typed.isEmpty || sent ? 0.1 : 1, y: typed.isEmpty || sent ? 0.5 : 1, anchor: .trailing)
            .offset(x: typed.isEmpty || sent ? 14 : 0).opacity(typed.isEmpty || sent ? 0 : 1)
            .animation(motion ? (typed.isEmpty || sent ? QuestionMotion.blobOut : QuestionMotion.blobIn) : nil,
              value: typed.isEmpty || sent)
            .allowsHitTesting(!typed.isEmpty && interactive)
            .accessibilityHidden(typed.isEmpty || sent)
            .accessibilityLabel("Send answer")
            .accessibilityIdentifier("widget-submit-" + message.id)
            .transition(.identity)
        }
      }
    }.modifier(QuestionTile(on: sent && !receipt, focused: customFocused && !sent, receipt: receipt, motion: motion))
      .onTapGesture { if interactive { customFocused = true } }
      .accessibilityElement(children: sent ? .ignore : .contain)
      .accessibilityLabel(sent ? kept : "")
      .accessibilityValue(sent ? "Selected" : "")
      .accessibilityIdentifier(identifier ?? "")
  }

  private func footer(
    multi: Bool, draft: String, going: Bool, settled: Bool, interactive: Bool, motion: Bool
  ) -> some View {
    let flying = flight?.kind == .skip
    let ready = !draft.isEmpty
    // The hint yields on narrow cards; the composer placeholder says the same thing. Only the
    // hint is offered a choice, so there is one Skip button, whose frame the flight starts from.
    return HStack(spacing: 6) {
      ViewThatFits(in: .horizontal) {
        Text("Or reply in chat").font(.footnote).foregroundStyle(QuestionPalette.tertiary)
          .lineLimit(1).fixedSize()
          .modifier(QuestionMelt(gone: settled, fading: going, motion: motion))
        Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
      }
      Spacer(minLength: 2)
      QuestionActionsLayout {
      Button { send(.skip) } label: {
        Text("Skip").font(.subheadline.weight(.medium))
          .foregroundStyle(QuestionPalette.secondary)
          .minimumScaleFactor(0.7)
          .padding(.horizontal, 13).frame(minHeight: 34)
          .contentShape(Capsule())
      }.buttonStyle(QuestionPressStyle(motion: motion))
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.space)) } action: { skipFrame.rect = $0 }
        // In flight the button is the blob drawn over the card.
        .opacity(flying ? 0 : 1)
        .animation(motion && !flying ? QuestionMotion.quick : nil, value: flying)
        .modifier(QuestionMelt(gone: settled && !flying, fading: going && !flying, motion: motion))
        .allowsHitTesting(interactive)
        .accessibilityHidden(going)
        .accessibilityLabel("Skip question")
        .accessibilityIdentifier("widget-dismiss-" + message.id)
      if multi {
        Button { send(.answer(draft)) } label: {
          Text("Send answer").font(.subheadline.weight(.semibold))
            .foregroundStyle(ready ? QuestionPalette.inverted : QuestionPalette.tertiary)
            .minimumScaleFactor(0.7)
            .padding(.horizontal, 14).frame(minHeight: 34)
            .background {
              // The fill floods in from the middle when there is something to send.
              ZStack {
                Capsule().fill(QuestionPalette.fillSelected)
                Capsule().fill(QuestionPalette.text)
                  .scaleEffect(x: ready ? 1 : 0.3, y: ready ? 1 : 0.1).opacity(ready ? 1 : 0)
              }.clipShape(Capsule())
            }
            .animation(motion ? (ready ? QuestionMotion.blobIn : QuestionMotion.blobOut) : nil, value: ready)
        }.buttonStyle(QuestionPressStyle(motion: motion))
          .keyframeAnimator(initialValue: 1.0, trigger: ready) { pill, scale in
            pill.scaleEffect(motion ? scale : 1)
          } keyframes: { _ in
            SpringKeyframe(ready ? 1.07 : 0.95, duration: 0.12, spring: .snappy)
            SpringKeyframe(1, duration: 0.3, spring: .bouncy)
          }
          .disabled(!ready)
          .modifier(QuestionMelt(gone: settled, fading: going, motion: motion))
          .allowsHitTesting(interactive)
          .accessibilityIdentifier("widget-submit-" + message.id)
      }
      }.layoutPriority(1)
    }.lineLimit(1)
  }

  private func toggle(_ value: String, options: [JSON]) {
    NativeHaptics.play(.selection, source: "widget.selection")
    var values = selected
    if values.contains(value) { values.remove(value) } else { values.insert(value) }
    var draft = store.draft(message.channelId)
    if draft.widgetSelections == nil { draft.widgetSelections = [:] }
    draft.widgetSelections?[message.id] = options.map(Self.value).filter(values.contains)
    store.saveDraft(draft, channel: message.channelId)
  }

  /// Shows the outcome at once, then asks the server. `lead` lets a tapped radio fill first.
  private func send(_ intent: QuestionIntent, lead: Duration = .zero) {
    let state = self.state
    guard !state.busy, state.pending == nil else { return }
    NativeHaptics.play(.light, source: "widget.submit")
    state.busy = true
    customFocused = false
    if state.failure != nil { state.failureStale = true }
    let suffix: String, value: String?
    switch intent {
    case .skip: (suffix, value) = ("widget-dismiss", nil)
    case .answer(let answer): (suffix, value) = ("widget-response", answer)
    }
    let action = suffix + "::" + (value.map { ":" + $0 } ?? "")
    if state.lastAction != action {
      state.lastAction = action
      state.requestID = UUID().uuidString
    }
    let clientID = state.requestID
    var payload: [String: JSON] = ["clientId": .string(clientID)]
    if let value { payload["value"] = .string(value) }
    let motion = !reduceMotion
    if lead == .zero || !motion { begin(intent, motion: motion) }
    Task { @MainActor in
      defer {
        state.busy = false
        state.settle()
      }
      if motion {
        if lead > .zero {
          try? await Task.sleep(for: lead)
          begin(intent, motion: motion)
        }
        // The card closes first: see the type's comment.
        try? await Task.sleep(for: intent == .skip ? QuestionMotion.skipHold : QuestionMotion.hold)
      }
      do {
        let result = try await store.request(
          "/api/v0/channel-messages/\(API.segment(message.id))/\(suffix)", method: "POST",
          body: .object(payload))
        if let updated = try? result["message"].decode(Message.self) {
          store.merge([updated], channel: updated.channelId)
          store.persist()
        }
        // A skip that lost the race to another way of closing the question still got what it
        // asked for: the question is closed, and there is nothing to report.
        let closedAnyway = intent == .skip && result["message"]["metadata"]["widgetDismissed"].bool
        guard closedAnyway || WidgetMutationReceipt.accepted(
          result, action: suffix, clientID: clientID, value: value.map { .string($0) } ?? .null) else {
          NativeHaptics.play(.error, source: "rich-action.result")
          fail("This action is no longer available. The card has been refreshed.")
          return
        }
        state.requestID = UUID().uuidString
        state.failure = nil
        state.failureStale = false
        if Self.settled(meta) { state.pending = nil }
      } catch {
        NativeHaptics.failure(error, source: "rich-action.result")
        fail(UserFacingError.message(error))
      }
    }
  }

  private func begin(_ intent: QuestionIntent, motion: Bool) {
    guard !Self.settled(meta) else { return }
    if intent == .skip, motion {
      state.chipLanded = false
      skipOrigin = skipFrame.rect
      flight = QuestionChipFlight(kind: .skip, from: skipFrame.rect)
    }
    state.pending = intent
  }

  /// The server refused: everything goes back to where it was, from wherever it is.
  private func fail(_ text: String) {
    let now = Date()
    state.pending = nil
    state.picked = nil
    state.failure = text
    state.failureStale = false
    guard !meta["widgetDismissed"].bool, !reduceMotion, skipOrigin != .zero, flight?.reversed == nil,
      flight == nil ? state.chipLanded : flight?.kind == .skip else { return }
    // A flight that has already landed takes off again from the chip.
    var flying = flight ?? QuestionChipFlight(kind: .skip, started: .distantPast, from: skipOrigin)
    flying.reversedTime = min(flying.time(at: now), flying.end)
    flying.reversed = now
    flight = flying
    state.chipLanded = false
  }
}
