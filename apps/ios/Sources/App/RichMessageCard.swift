import SwiftUI

extension JSON {
  var pretty: String {
    let e = JSONEncoder()
    e.outputFormatting = [.prettyPrinted, .sortedKeys]
    return (try? e.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
  }
}

struct RichMessageCard: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(MessageModalPresenter.self) private var modals
  @Environment(AppStore.self) private var store
  let message: Message
  private var selected: Set<String> {
    Set(store.draft(message.channelId).widgetSelections?[message.id] ?? [])
  }
  @State private var secret = ""
  @State private var formValues: [String: JSON] = [:]
  @State private var bodyText = ""
  @State private var subject = ""
  @State private var to = ""
  @State private var cc = ""
  @State private var fromAddress = ""
  @State private var draftNotice: String?
  @State private var draftBodyExpanded = false
  @State private var draftSending = false
  @State private var draftSendOff = DraftSendOff.idle
  /// The send-off under way is Discard's.
  @State private var draftDiscards = false
  /// Measured heights the card closes between while the send-off flies.
  @State private var draftFormHeight: CGFloat = 0
  @State private var draftSettledHeight: CGFloat = 0
  @State private var draftHeldHeight: CGFloat?
  /// From the top of what the blob swallows on a text's card down to the Send row.
  @State private var draftPayloadHeight: CGFloat = 0
  @State private var draftPressed = Date.distantPast
  @State private var draftClosing: Date?
  @State private var draftGathered = false
  @State private var draftFades = false
  /// How far the send-off has got: 1 the card closes, 2 the summary is written, 3 "Sending" fades,
  /// 4 the Sent badge fills in.
  @State private var draftStep = 0
  @State private var draftSlings = 0
  @State private var draftDrops = 0
  /// Where the Discard pill starts across the card, for what its blob swallows to aim at.
  @State private var draftDiscardX: CGFloat = 0
  @State private var draftHistoryExpanded = false
  @State private var draftRevisionEditing = false
  @FocusState private var draftBodyFocused: Bool
  @State private var busy = false
  @State private var importID = UUID().uuidString
  @State private var failure: String?
  @State private var saveToVault = false
  @State private var requestID = UUID().uuidString
  @State private var lastAction = ""
  private var meta: JSON { message.metadata }
  private var type: String { meta["type"].string }
  private var state: String {
    meta["cardState"].string.isEmpty ? "pending" : meta["cardState"].string
  }
  /// Drafts and text approvals share the reference draft card's frame.
  private var isDraftLike: Bool { type == "external-draft" || type == "imessage-send" }
  private var supported: Bool {
    return [
      "widget", "secret-request", "computer-handoff", "user-form", "external-draft",
      "imessage-send", "bot-template",
    ].contains(type)
  }
  var body: some View {
    if type == "presentation", let presentation = PresentationPayload.parse(meta["presentation"]) {
      PresentationMessageView(presentation: presentation, stateKey: message.id)
        .padding(12)
        .background(NativePalette.assistant, in: RoundedRectangle(cornerRadius: 22))
    } else if supported {
      VStack(alignment: .leading, spacing: type == "widget" ? 12.25 : isDraftLike ? 10 : 13) {
        if let failure = failure ?? draftPressFailure { InlineFailure(message: failure) }
        switch type {
        case "widget": widget
        case "secret-request": secretRequest
        case "computer-handoff": handoff
        case "user-form": form
        case "external-draft": externalDraft
        case "imessage-send": imessageSend
        case "bot-template": sharedTemplate
        default: EmptyView()
        }
      }.padding(type == "widget" ? 0 : isDraftLike ? 12 : 16).background(
        type == "widget" ? Color.clear : NativePalette.surface, in: RoundedRectangle(cornerRadius: isDraftLike ? 16 : 18)
      )
      // The card gives as the blob lets go, and takes the hit when it lands.
      .keyframeAnimator(initialValue: CGFloat.zero, trigger: draftSlings) { card, shift in
        card.offset(x: shift)
      } keyframes: { _ in
        CubicKeyframe(-2, duration: 0.045)
        CubicKeyframe(0, duration: DraftSendOff.hit - DraftSendOff.sling - 0.045)
        CubicKeyframe(3, duration: 0.05)
        CubicKeyframe(-1, duration: 0.09)
        CubicKeyframe(0, duration: 0.1)
      }
      // Discarding, it dips once the blob has let go of it.
      .keyframeAnimator(initialValue: CGFloat.zero, trigger: draftDrops) { card, dip in
        card.offset(y: dip)
      } keyframes: { _ in
        CubicKeyframe(2, duration: 0.05)
        CubicKeyframe(0, duration: 0.19)
      }
      .animation(type == "widget" && !reduceMotion ? .easeOut(duration: 0.24) : nil,
        value: meta["respondedValue"])
      .animation(type == "widget" && !reduceMotion ? .easeOut(duration: 0.24) : nil,
        value: meta["widgetDismissed"])
      .task(id: message.id) {
        if type == "user-form", state == "pending" {
          do {
            let prefill = try await store.request(
              "/api/v0/channel-messages/\(API.segment(message.id))/user-form/prefill",
              method: "POST", body: .object([:]))
            formValues = prefill.object.merging(formValues) { _, edited in edited }
          } catch { /* Prefill is optional; an unavailable vault must not prevent manual entry. */
          }
        }
      }
      .onChange(of: formValues) { _, _ in
        requestID = UUID().uuidString
        failure = nil
      }
      .onChange(of: secret) { _, _ in
        requestID = UUID().uuidString
        failure = nil
      }
      .onChange(of: selected) { _, _ in requestID = UUID().uuidString }
      .onChange(of: bodyText) { _, value in
        requestID = UUID().uuidString
        if value != meta["draft"]["body"].string { draftRevisionEditing = true }
      }
      .onChange(of: to) { _, value in
        requestID = UUID().uuidString
        if value != meta["draft"]["to"].array.map(\.string).joined(separator: ", ") { draftRevisionEditing = true }
      }
      .onChange(of: cc) { _, value in
        requestID = UUID().uuidString
        if value != meta["draft"]["cc"].array.map(\.string).joined(separator: ", ") { draftRevisionEditing = true }
      }
      .onChange(of: saveToVault) { _, _ in requestID = UUID().uuidString }
      .onChange(of: subject) { _, value in
        requestID = UUID().uuidString
        if value != meta["draft"]["subject"].string { draftRevisionEditing = true }
      }
      .disabled(busy || store.busy.contains("/api/v0/channel-messages/\(API.segment(message.id))/widget-response"))
      .onAppear {
        resetDraftFields()
        resumeDraftSendOff()
      }
      .onChange(of: meta["draft"]) { previous, incoming in
        if type == "external-draft" { syncDraftFields(from: previous, to: incoming) }
      }
      .onChange(of: state) { _, value in
        if type == "external-draft" {
          if value == "dismissed" { resetDraftFields() }
          if value != "pending" && value != "sending" { draftSending = false }
        }
        if isDraftLike, value == "sent" || value == "dismissed" { failure = nil }
        advanceDraftSendOff()
      }
      .onChange(of: draftSending) { _, _ in advanceDraftSendOff() }
      .onChange(of: draftOut) { _, out in
        // The press may have been an earlier row's of this card, which is the one told how it ended.
        if !out { draftSending = false }
        advanceDraftSendOff()
      }
      .onDisappear {
        secret = ""
        formValues = [:]
        leaveDraftSendOff()
      }
    }
  }
  private func resetDraftFields() {
    bodyText = meta["draft"]["body"].string
    subject = meta["draft"]["subject"].string
    to = meta["draft"]["to"].array.map(\.string).joined(separator: ", ")
    cc = meta["draft"]["cc"].array.map(\.string).joined(separator: ", ")
    fromAddress = meta["draft"]["from"].string
  }
  private func syncDraftFields(from previous: JSON, to incoming: JSON) {
    if bodyText == previous["body"].string { bodyText = incoming["body"].string }
    if subject == previous["subject"].string { subject = incoming["subject"].string }
    if to == previous["to"].array.map(\.string).joined(separator: ", ") {
      to = incoming["to"].array.map(\.string).joined(separator: ", ")
    }
    if cc == previous["cc"].array.map(\.string).joined(separator: ", ") {
      cc = incoming["cc"].array.map(\.string).joined(separator: ", ")
    }
    if fromAddress == previous["from"].string { fromAddress = incoming["from"].string }
  }
  private func presentComputer() {
    if let bot = store.bots.first(where: { $0.id == message.senderBotId })
      ?? store.channel(message.channelId).flatMap({ store.bot(for: $0) }) {
      modals.fullScreen = .init(content: AnyView(ComputerView(bot: bot,
        handoffID: type == "computer-handoff" ? message.id : nil)))
    }
  }
  @ViewBuilder var widget: some View {
    let widget = meta["widget"]
    VStack(alignment: .leading, spacing: 12.25) {
      HStack(alignment: .top, spacing: 8) {
        Text(widget["prompt"].string).font(.body.weight(.medium))
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
        if meta["respondedValue"] == .null && !meta["widgetDismissed"].bool {
          Button { act("widget-dismiss") } label: {
            Image(systemName: "xmark").font(.system(size: 15, weight: .regular))
              .foregroundStyle(NativePalette.chatFaint).frame(width: 20, height: 20)
              .contentShape(Rectangle().inset(by: -10))
          }.buttonStyle(.plain).accessibilityLabel("Dismiss")
            .accessibilityIdentifier("widget-dismiss-" + message.id)
        }
      }
      if !widget["helpText"].string.isEmpty {
        Text(widget["helpText"].string).font(.system(size: 14))
          .foregroundStyle(NativePalette.chatFaint).padding(.trailing, 36)
      }
      if case .string(let response) = meta["respondedValue"] {
        let answers = WidgetAnswer.resolve(widget: widget, response: response)
        VStack(spacing: 0) {
          ForEach(Array(answers.enumerated()), id: \.offset) { index, answer in
            if index > 0 { NativePalette.separator.frame(height: 0.5) }
            HStack(spacing: 12) {
              Text(answer.label).fixedSize(horizontal: false, vertical: true)
              Spacer(minLength: 8)
              Path { path in
                path.move(to: CGPoint(x: 3, y: 8))
                path.addLine(to: CGPoint(x: 6, y: 11))
                path.addLine(to: CGPoint(x: 13, y: 4))
              }.stroke(NativePalette.receiptCheck,
                style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                .frame(width: 16, height: 16).accessibilityHidden(true)
            }.padding(.horizontal, 10).padding(.vertical, 10)
              .frame(minHeight: 40).accessibilityElement(children: .combine)
              .accessibilityValue("Selected")
              .accessibilityIdentifier("widget-answer-\(message.id)-\(index)")
          }
        }.background(NativePalette.background, in: RoundedRectangle(cornerRadius: 12))
          .overlay(RoundedRectangle(cornerRadius: 12).stroke(NativePalette.separator, lineWidth: 0.5))
      } else {
        let dismissed = meta["widgetDismissed"].bool
        VStack(spacing: 0) {
          ForEach(Array(widget["options"].array.enumerated()), id: \.offset) { index, option in
            let value = option["value"].string.isEmpty ? option["label"].string : option["value"].string
            Button {
              if widget["multiSelect"].bool {
                NativeHaptics.play(.selection, source: "widget.selection")
                var values = selected
                if values.contains(value) { values.remove(value) } else { values.insert(value) }
                var draft = store.draft(message.channelId)
                draft.widgetResponse = nil
                if draft.widgetSelections == nil { draft.widgetSelections = [:] }
                draft.widgetSelections?[message.id] = widget["options"].array.map {
                  $0["value"].string.isEmpty ? $0["label"].string : $0["value"].string
                }.filter(values.contains)
                store.saveDraft(draft, channel: message.channelId)
              } else { act("widget-response", body: ["value": .string(value)]) }
            } label: {
              HStack(alignment: .top, spacing: 11) {
                Text(index < 26 ? String(UnicodeScalar(65 + index)!) : String(index + 1))
                  .font(.system(size: 13))
                  .foregroundStyle(Color(hex: "979699"))
                  .frame(width: 24, height: 24)
                  .background(NativePalette.separator.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                  .overlay(RoundedRectangle(cornerRadius: 8)
                    .stroke(NativePalette.separator, lineWidth: 1))
                  .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3.5) {
                  Text(option["label"].string).font(.body)
                    .foregroundStyle(option["style"].string == "danger"
                      ? NativePalette.widgetDanger : NativePalette.text)
                  if !option["description"].string.isEmpty {
                    Text(option["description"].string).font(.system(size: 14))
                      .foregroundStyle(NativePalette.chatMuted)
                  }
                }.fixedSize(horizontal: false, vertical: true).padding(.top, 2)
                Spacer(minLength: 0)
                if selected.contains(value) {
                  Image(systemName: "checkmark").font(.system(size: 14))
                    .foregroundStyle(NativePalette.receiptCheck)
                }
              }.padding(.vertical, 8)
                .frame(maxWidth: .infinity, minHeight: 41, alignment: .leading)
                .contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(dismissed)
              .accessibilityLabel(option["label"].string)
              .accessibilityValue(selected.contains(value) ? "Selected" : "")
          }
        }.opacity(dismissed ? 0.35 : 1)
        if dismissed {
          Text("dismissed").font(.system(size: 12)).foregroundStyle(NativePalette.chatFaint)
            .accessibilityIdentifier("widget-dismissed-" + message.id)
        } else {
          if widget["multiSelect"].bool {
            Button {
              let values = widget["options"].array.map {
                $0["value"].string.isEmpty ? $0["label"].string : $0["value"].string
              }.filter(selected.contains)
              act("widget-response", body: ["value": .string(values.joined(separator: "\n"))])
            } label: {
              Text("Submit").font(.system(size: 15, weight: .medium))
                .foregroundStyle(selected.isEmpty ? NativePalette.chatFaint : NativePalette.onPrimary)
                .frame(maxWidth: .infinity).frame(height: 38)
                .background(selected.isEmpty ? NativePalette.widgetDisabled : NativePalette.text,
                  in: RoundedRectangle(cornerRadius: 9))
            }.buttonStyle(WidgetSubmitStyle()).disabled(selected.isEmpty)
              .accessibilityIdentifier("widget-submit-" + message.id)
          }
        }
      }
    }.padding(14)
      .background(NativePalette.surface, in: RoundedRectangle(cornerRadius: 18))
      .overlay(RoundedRectangle(cornerRadius: 18)
        .stroke(NativePalette.separator, lineWidth: 0.5))
    if meta["respondedValue"] == .null && !meta["widgetDismissed"].bool && widget["allowCustom"].bool {
      Text("Or answer in the chat below").font(.system(size: 14))
        .foregroundStyle(NativePalette.chatFaint).padding(.leading, 14)
    }
  }
  @ViewBuilder var secretRequest: some View {
    let request = meta["secretRequest"] == .null ? meta["secret"] : meta["secretRequest"]
    Text(request["label"].string.isEmpty ? "Secure input" : request["label"].string).font(.headline)
    if !request["description"].string.isEmpty { Text(request["description"].string).font(.subheadline) }
    if !request["name"].string.isEmpty {
      Text(request["name"].string).font(.system(.caption, design: .monospaced)).foregroundStyle(NativePalette.muted)
    }
    let botSecret = !request["name"].string.isEmpty && request["scope"].string != "personal"
    Label(botSecret ? "Saved for all users of this Bot" : "Saved securely for you", systemImage: "lock.shield")
      .font(.footnote).foregroundStyle(NativePalette.muted)
    if meta["secretProvided"].bool {
      Label("Provided securely", systemImage: "checkmark.shield")
    } else {
      SecureField("Value", text: $secret).textContentType(.password).textFieldStyle(.roundedBorder)
      Button("Submit securely") {
        act("secret", body: ["value": .string(secret)], clearSecrets: true)
      }.disabled(secret.isEmpty)
    }
  }
  @ViewBuilder var handoff: some View {
    Label("Your help is needed", systemImage: "desktopcomputer").font(.headline)
    Text(meta["computerHandoff"]["reason"].string)
    let status = meta["computerHandoffState"].string
    if ["", "requested"].contains(status) {
      HStack {
        Button("Skip") { act("computer-handoff", body: ["action": .string("skip")]) }
        Spacer()
        Button("Take over") { act("computer-handoff", body: ["action": .string("start")]) }
      }
    } else {
      Text(status.capitalized).foregroundStyle(NativePalette.muted)
      if ["active", "started"].contains(status) {
        Button("Continue on computer") { presentComputer() }
      }
    }
  }
  @ViewBuilder var form: some View {
    let form = meta["form"]
    Text(form["title"].string).font(.headline)
    if state != "pending" {
      let outcome = UserFormOutcome(meta)
      Text(outcome.summary).font(.subheadline).foregroundStyle(NativePalette.muted)
      ForEach(outcome.fields) { field in
        HStack {
          Text(field.label)
          Spacer()
          Text(field.status).foregroundStyle(NativePalette.muted)
        }.font(.footnote).accessibilityElement(children: .combine)
      }
      if outcome.needsRecovery || state == "escalated" {
        Button("Open computer", systemImage: "display") { presentComputer() }
      }
    } else {
      Text(form["instruction"].string).font(.subheadline)
      if !form["domain"].string.isEmpty {
        Label(form["domain"].string, systemImage: "lock.shield").font(.caption)
      }
      ForEach(Array(form["fields"].array.enumerated()), id: \.offset) { _, field in
        let id = field["id"].string
        let binding = Binding<String>(
          get: { formValues[id]?.string ?? "" }, set: { formValues[id] = .string($0) })
        VStack(alignment: .leading, spacing: 6) {
          if field["type"].string != "checkbox" {
            Text(field["label"].string + (field["required"].bool ? " *" : "")).font(.subheadline)
          }
          if field["type"].string == "checkbox" {
            Toggle(
              field["label"].string,
              isOn: Binding(
                get: { formValues[id]?.bool ?? false }, set: { formValues[id] = .bool($0) }))
          } else if field["type"].string == "select" {
            Picker("Choose", selection: binding) {
              Text("Select…").tag("")
              ForEach(Array(field["options"].array.enumerated()), id: \.offset) { _, option in
                Text(option["label"].string).tag(option["value"].string)
              }
            }
          } else if field["secret"].bool || ["password", "otp"].contains(field["type"].string) {
            SecureField(field["placeholder"].string, text: binding).accessibilityIdentifier(
              "form-field-" + id
            ).accessibilityLabel(field["label"].string).textFieldStyle(.roundedBorder)
              .textInputAutocapitalization(.never)
          } else {
            TextField(field["placeholder"].string, text: binding, axis: .vertical)
              .accessibilityIdentifier("form-field-" + id).accessibilityLabel(field["label"].string)
              .textFieldStyle(
                .roundedBorder
              ).textInputAutocapitalization(.never)
              .keyboardType(
                field["type"].string == "email"
                  ? .emailAddress
                  : field["type"].string == "tel"
                    ? .phonePad : field["type"].string == "number" ? .decimalPad : .default)
          }
        }
      }
      if form["fields"].array.contains(where: {
        !$0["secret"].bool && !["password", "otp"].contains($0["type"].string)
      }) {
        Toggle("Save nonsecret info for future forms", isOn: $saveToVault).font(.footnote)
      }
      if form["submitAfterFill"].bool {
        Text("After filling, this presses Enter on \(form["domain"].string).").font(.footnote)
          .foregroundStyle(NativePalette.muted)
      }
      Button("Do this on the computer", systemImage: "display") {
        act("user-form", body: ["action": .string("dismiss"), "mode": .string("escalated")], clearSecrets: true)
      }.accessibilityIdentifier("form-escalate")
      HStack {
        Button("Dismiss") {
          act("user-form", body: ["action": .string("dismiss")], clearSecrets: true)
        }
        Spacer()
        Button("Submit") {
          act(
            "user-form",
            body: [
              "action": .string("submit"), "values": .object(formValues),
              "saveToVault": .bool(saveToVault),
            ], clearSecrets: true)
        }.disabled(!formValid)
      }
    }
  }
  var formValid: Bool {
    do {
      try FormValidation.userForm(meta["form"], values: formValues)
      return true
    } catch { return false }
  }
  private var draftBot: Bot? { store.bots.first { $0.id == message.senderBotId } }
  private var draftIsEmail: Bool { meta["draft"]["platform"].string == "email" }
  private static func addresses(_ text: String) -> [String] {
    text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
  }
  /// Mirrors externalDraftApprovalMode in @openteam/contracts.
  private var draftMode: String {
    guard let bot = draftBot else { return "needs-approval" }
    if bot.draftingDisabled == true { return "disable-drafts" }
    let allowed = Set((bot.draftAllowedRecipients ?? []).map { $0.lowercased() })
    let recipients = Set((Self.addresses(to) + Self.addresses(cc)).map { $0.lowercased() })
    return draftIsEmail && !recipients.isEmpty && recipients.isSubset(of: allowed)
      ? "always-allow" : "needs-approval"
  }
  private static let modeLabels = [
    "always-allow": "Always allow", "needs-approval": "Needs approval",
    "disable-drafts": "Disable drafts for Bot",
  ]
  private static func approvalNotice(from previous: String, to next: String) -> String {
    switch next {
    case "always-allow": "Added to your Allow rules"
    case "disable-drafts": "Drafts are off for this Bot"
    default: previous == "disable-drafts" ? "Drafts need your approval again" : "Removed from your Allow rules"
    }
  }
  @ViewBuilder private var approvalMenu: some View {
    if draftBot != nil {
      Menu {
        ForEach(draftIsEmail ? ["always-allow", "needs-approval", "disable-drafts"] : ["needs-approval", "disable-drafts"], id: \.self) { mode in
          Button {
            if mode != draftMode { setDraftApproval(mode) }
          } label: {
            if mode == draftMode { Label(Self.modeLabels[mode]!, systemImage: "checkmark") } else { Text(Self.modeLabels[mode]!) }
          }
        }
      } label: {
        HStack(spacing: 4) {
          Text(draftMode == "disable-drafts" ? "Disable drafts" : Self.modeLabels[draftMode]!)
            .font(.system(size: 14)).kerning(-0.08)
          Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
            .foregroundStyle(DraftPalette.iconSecondary)
        }.foregroundStyle(DraftPalette.secondary).padding(.vertical, 4).padding(.leading, 6)
      }.accessibilityLabel("Approval")
    }
  }
  /// The label column fits the longest label, like the reference card's max-content column.
  private static func labelWidth(_ labels: [String]) -> CGFloat {
    labels.map { ($0 as NSString).size(withAttributes: [.font: UIFont.systemFont(ofSize: 13)]).width }
      .max().map { ceil($0) } ?? 0
  }
  @ViewBuilder private func draftReplyRow(width: CGFloat) -> some View {
    let draft = meta["draft"]
    let thread = draft["verification"]["thread"].string.isEmpty
      ? draft["replyToMessageId"].string : draft["verification"]["thread"].string
    if draftIsEmail, !draft["replyToMessageId"].string.isEmpty {
      if let url = URL(string: draft["verification"]["threadUrl"].string), url.scheme == "https" {
        // The whole row opens the original message, as on desktop.
        Link(destination: url) { DraftRow(label: "In reply to", width: width) { DraftValue(thread) } }
      } else {
        DraftRow(label: "In reply to", width: width) { DraftValue(thread) }
      }
    }
    if draftIsEmail, !draft["forwardMessageId"].string.isEmpty {
      let forwarding = draft["verification"]["forwarding"].string.isEmpty
        ? draft["forwardMessageId"].string : draft["verification"]["forwarding"].string
      if let url = URL(string: draft["verification"]["forwardUrl"].string), url.scheme == "https" {
        Link(destination: url) { DraftRow(label: "Forwarding", width: width) { DraftValue(forwarding) } }
      } else {
        DraftRow(label: "Forwarding", width: width) { DraftValue(forwarding) }
      }
    }
  }
  private var draftAssets: [Asset] {
    meta["draft"]["verification"]["attachments"].array.compactMap { try? $0.decode(Asset.self) }
  }
  @ViewBuilder private var draftAttachments: some View {
    if !draftAssets.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(Array(draftAssets.enumerated()), id: \.offset) { _, asset in
          AttachmentView(asset: asset, channelID: message.channelId, messageID: message.id)
        }
      }.padding(10).accessibilityLabel("Attachments")
    }
  }
  private var revisionBody: AttributedString {
    var result = AttributedString()
    for part in meta["draft"]["verification"]["revision"]["body"].array {
      var run = AttributedString(part["text"].string)
      if part["added"].bool { run.backgroundColor = .green.opacity(0.16) }
      result.append(run)
    }
    return result
  }
  @ViewBuilder private var draftNotices: some View {
    let sentUnder = meta["sentUnder"]
    if !sentUnder["rule"].string.isEmpty {
      DraftNote("Auto-approved by your rule: " + sentUnder["rule"].string)
    } else if sentUnder["draftingDisabled"].bool {
      DraftNote((state == "sent" ? "Sent without review" : "Review skipped") + ": drafts are off for this Bot")
    }
    if let draftNotice { DraftNote(draftNotice) }
    if state == "pending", !meta["sendError"].string.isEmpty {
      DraftNote("Couldn't send this draft: " + meta["sendError"].string, alert: true)
    }
  }
  private var draftSignature: String? {
    let html = meta["draft"]["verification"]["signatures"][fromAddress.lowercased()].string
    return html.isEmpty ? nil : signatureText(html)
  }
  private var draftBodyOverflows: Bool {
    bodyText.split(separator: "\n", omittingEmptySubsequences: false).reduce(0) {
      $0 + max(1, ($1.count + 39) / 40)
    } > 12
  }
  private func draftField(_ prompt: String, text: Binding<String>, label: String, email: Bool = true) -> some View {
    TextField("", text: text, prompt: Text(verbatim: prompt).foregroundStyle(DraftPalette.quaternary), axis: .vertical)
      .lineLimit(1...4).fixedSize(horizontal: false, vertical: true)
      .font(.system(size: 15)).kerning(-0.15).foregroundStyle(DraftPalette.secondary)
      .textInputAutocapitalization(email ? .never : .sentences).autocorrectionDisabled(email)
      .keyboardType(email ? .emailAddress : .default).accessibilityLabel(label)
      .background(!draftRevisionEditing && meta["draft"]["verification"]["revision"]["changedFields"].array.contains(.string(label.lowercased())) ? Color.green.opacity(0.16) : Color.clear)
  }
  @ViewBuilder var externalDraft: some View {
    let draft = meta["draft"]
    let verification = draft["verification"]
    let email = draftIsEmail
    let title = email ? (!draft["replyToMessageId"].string.isEmpty ? "Reply" : !draft["forwardMessageId"].string.isEmpty ? "Forward" : "New email") : "Slack message"
    let sending = state == "sending" || draftSending
    let width = Self.labelWidth(
      email
        ? ["From", "To", "Cc", "Subject"] + (draft["replyToMessageId"].string.isEmpty ? [] : ["In reply to"]) + (draft["forwardMessageId"].string.isEmpty ? [] : ["Forwarding"])
        : ["Workspace", "To"])
    let open = state == "pending" || state == "sending"
    let animating = draftAnimating
    let confirmed = draftSendOff.confirmed
    let plainSending = sending && !animating
    let waiting = animating && draftSendOff != .reverting
    let discarding = animating && draftDiscards
    draftSendOffCard {
    HStack(spacing: 8) {
      Text(verbatim: title).font(.system(size: 15, weight: .medium)).kerning(-0.15)
        .foregroundStyle(DraftPalette.text).lineLimit(1)
      Spacer(minLength: 0)
      // Discarding, the badge says what it said until it goes as the card closes.
      DraftStatusBadge(state: discarding ? "pending" : animating || sending ? "sending" : state)
        .opacity(animating && draftStep >= (draftDiscards ? 1 : 3) ? 0 : 1)
        .animation(discarding ? .easeOut(duration: DraftSendOff.close.duration) : nil, value: draftStep >= 1)
        .overlay(alignment: .trailing) {
          // The real Sent badge comes up under the green stamp the send-off leaves on it; the
          // Discarded one fades in with the summary.
          if animating {
            DraftStatusBadge(state: draftDiscards ? "dismissed" : "sent", anchorsFrame: true)
              .opacity(draftStep >= (draftDiscards ? 2 : 4) ? 1 : 0)
          }
        }
    }
    draftClosingSection(open: open) {
      draftSettled(draft: draft, email: email, width: width)
    } form: {
     VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 0) {
        VStack(alignment: .leading, spacing: 0) {
          if email {
            DraftRow(label: "From", width: width) {
              let addresses = verification["sendingAddresses"].array.map(\.string)
              if addresses.count > 1 {
                Menu {
                  ForEach(addresses, id: \.self) { address in
                    Button {
                      fromAddress = address
                    } label: {
                      if address == fromAddress.lowercased() { Label(address, systemImage: "checkmark") } else { Text(address) }
                    }
                  }
                } label: {
                  HStack(spacing: 4) {
                    DraftValue(fromAddress).truncationMode(.middle)
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
                      .foregroundStyle(DraftPalette.iconSecondary)
                  }
                }.accessibilityLabel("From")
              } else {
                DraftValue(fromAddress)
              }
            }
            draftReplyRow(width: width)
            DraftRow(label: "To", width: width) { draftField("name@example.com", text: $to, label: "To") }
            DraftRow(label: "Cc", width: width) { draftField("name@example.com", text: $cc, label: "Cc") }
            DraftRow(label: "Subject", width: width) { draftField("Subject", text: $subject, label: "Subject", email: false) }
          } else {
            DraftRow(label: "Workspace", width: width) { DraftValue(verification["identity"].string) }
            DraftRow(label: "To", width: width) { DraftValue(draft["target"].string) }
          }
        }
        if !draftRevisionEditing && bodyText == draft["body"].string && draft["verification"]["revision"]["body"].array.contains(where: { $0["added"].bool }) {
          Button { draftRevisionEditing = true; draftBodyFocused = true } label: {
            Text(revisionBody).font(.system(size: 16)).foregroundStyle(DraftPalette.text)
              .frame(maxWidth: .infinity, alignment: .leading).padding(10)
          }.buttonStyle(.plain).accessibilityLabel("Message body, changes highlighted, tap to edit")
        } else {
        TextField("", text: $bodyText, prompt: Text(verbatim: "Write a message").foregroundStyle(DraftPalette.quaternary), axis: .vertical)
          .lineLimit(draftBodyExpanded || !draftBodyOverflows ? 4...10_000 : 4...12)
          .font(.system(size: 16)).foregroundStyle(DraftPalette.text)
          .padding(10).accessibilityLabel("Message body")
          .focused($draftBodyFocused)
        }
        if draftBodyOverflows {
          Button {
            draftBodyExpanded.toggle()
          } label: {
            HStack(spacing: 4) {
              Text(draftBodyExpanded ? "Show less" : "Show more").font(.system(size: 14)).kerning(-0.08)
              Image(systemName: draftBodyExpanded ? "chevron.up" : "chevron.down").font(.system(size: 9, weight: .semibold))
            }.foregroundStyle(DraftPalette.tertiary).padding(.horizontal, 6).frame(height: 26)
          }.buttonStyle(.plain).padding(.horizontal, 10).padding(.top, 4).padding(.bottom, 10)
        }
        if let draftSignature {
          Text(verbatim: draftSignature).font(.system(size: 15)).foregroundStyle(DraftPalette.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8).padding(.bottom, 10)
            .overlay(alignment: .top) {
              Line().stroke(DraftPalette.divider, style: StrokeStyle(lineWidth: 1, dash: [3, 3])).frame(height: 1)
            }
            .padding(.horizontal, 10)
        }
        draftAttachments
      }
      .background(DraftPalette.panel, in: RoundedRectangle(cornerRadius: 10))
      .clipShape(RoundedRectangle(cornerRadius: 10))
      .disabled(sending)
      draftNotices
      }
      .modifier(DraftSwallowed(swallowed: confirmed, blob: CGSize(width: draftBlobX, height: 27)))
      HStack(spacing: 8) {
        Button {
          draftAction("send")
        } label: {
          HStack(spacing: 6) {
            if plainSending { LoadingOrb(size: 14, label: "Sending") }
            Text(plainSending ? "Sending…" : "Send")
          }
        }.buttonStyle(DraftButtonStyle(primary: true, sending: plainSending))
          .disabled(sending || draftOut || bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (email && !EmailDraftReview.validRecipients(to: to, cc: cc)))
          .modifier(DraftSendOffPill(pressed: !draftDiscards, animating: animating, waiting: waiting))
          .accessibilityIdentifier("draft-send-button")
        Button("Discard") { act("external-draft", body: ["action": .string("cancel")]) }
          .buttonStyle(DraftButtonStyle(primary: false, sending: false)).disabled(sending || draftOut)
          .modifier(DraftSendOffPill(pressed: draftDiscards, animating: animating, waiting: waiting, start: $draftDiscardX))
        Spacer(minLength: 0)
        approvalMenu
          .opacity(waiting ? 0 : 1)
      }.animation(.easeOut(duration: 0.12), value: waiting)
     }
    }
    }
  }
  /// The send-off draws the Send pill itself, from the tap until the blob lands or returns.
  private var draftAnimating: Bool { draftSendOff.active && !reduceMotion }
  /// A draft card's header and closing section, with the send-off drawn over them.
  private func draftSendOffCard<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 10) { content() }
    .coordinateSpace(.named(DraftSendOffPill.card))
    .overlayPreferenceValue(DraftSendAnchors.self) { anchors in
      if draftAnimating, let pill = anchors["pill"], let badge = anchors["badge"], let edge = anchors["edge"] {
        GeometryReader { proxy in
          DraftSendOffEffect(
            phase: draftSendOff, discards: draftDiscards, pill: proxy[pill],
            badge: proxy[badge],
            // The card is this content plus its 12 pt padding; its bottom edge carries the blob.
            card: CGRect(x: 0, y: 0, width: proxy.size.width, height: proxy[edge].maxY).insetBy(dx: -12, dy: -12),
            closing: max(0, proxy[edge].height - draftSettledHeight), gathered: draftGathered)
        }
      }
    }
  }
  /// The part of a draft card under its header: the open form, which closes onto the summary of
  /// the settled card as the send-off flies.
  private func draftClosingSection<Settled: View, Form: View>(
    open: Bool, @ViewBuilder settled: () -> Settled, @ViewBuilder form: () -> Form
  ) -> some View {
    let animating = draftAnimating
    return ZStack(alignment: .topLeading) {
    if animating {
      // Laid out under the form from the press, and written in the blob's wake; discarding, it
      // fades in once the blob has dropped.
      settled()
        .mask {
          Rectangle().padding(-4).scaleEffect(x: draftDiscards || draftStep >= 2 ? 1 : 0, anchor: .leading)
        }
        .opacity(draftDiscards && draftStep < 2 ? 0 : 1)
        .allowsHitTesting(false)
        .background { DraftHeightReader(height: $draftSettledHeight) }
    } else if !open {
      // Under Reduce Motion an email sent from this device ends in a plain fade to the summary.
      settled()
        .transition(draftFades ? .opacity.animation(.easeInOut(duration: 0.25)) : .identity)
    }
    if open || animating {
     form()
     // Keeps its own height while the card closes over it.
     .fixedSize(horizontal: false, vertical: true)
     .background { if animating { DraftHeightReader(height: $draftFormHeight) } }
    }
    }
    .modifier(DraftClosingHeight(
      height: draftHeldHeight, closing: draftStep == 1 ? draftClosing : nil, from: draftFormHeight))
    .clipShape(Rectangle().inset(by: draftSendOff.confirmed ? 0 : -60))
    .background {
      if animating { Color.clear.anchorPreference(key: DraftSendAnchors.self, value: .bounds) { ["edge": $0] } }
    }
  }
  /// The blob's centre across the card: the pressed pill's leading end.
  private var draftBlobX: CGFloat { (draftDiscards ? draftDiscardX : 0) + DraftSendOff.blob / 2 }
  /// This device pressed Send or Discard on the card and has not seen the answer.
  private var draftOut: Bool { store.draftPresses[message.id] != nil }
  /// Why this device's last Send or Discard of the card failed, when the row that pressed it has
  /// gone since.
  private var draftPressFailure: String? {
    state == "pending" || state == "sending" ? store.draftPressFailures[message.id] : nil
  }
  /// A card whose Send or Discard this device pressed and has not seen answered comes back as it
  /// was left: the blob, waiting, without gathering again. One answered meanwhile is just the
  /// settled card.
  private func resumeDraftSendOff() {
    guard let press = store.draftPresses[message.id], state == "pending" || state == "sending",
      draftSendOff == .idle
    else { return }
    // At once: the row is first drawn as the plain card, which must not be seen fading out.
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) {
      draftSending = !press.discards
      draftDiscards = press.discards
      draftPressed = press.at
      draftStep = 0
      draftGathered = true
      draftSendOff = .pressed
    }
  }
  /// The press that starts a send-off: the pill is drawn once as it was, then gathers into the blob.
  private func pressDraftSendOff(discards: Bool) {
    if !reduceMotion { NativeHaptics.draftSendPress(source: discards ? "draft.discard" : "draft.send") }
    draftDiscards = discards
    draftPressed = Date()
    store.draftPresses[message.id] = DraftPress(discards: discards, at: draftPressed)
    draftStep = 0
    draftFades = reduceMotion && !discards && type == "external-draft"
    draftGathered = false
    // Owned here rather than by the blob's own appearance, which a row update arriving with a fast
    // answer can swallow.
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(34))
      draftGathered = true
    }
    draftSendOff = .pressed
  }
  /// The row has left the screen. Nothing of the send-off is kept in it: a send still out is in
  /// the store for the row that comes back, and a send-off under way ends here, unseen and unfelt.
  private func leaveDraftSendOff() {
    guard draftSendOff.active else { return }
    draftSendOff = .idle
    draftHeldHeight = nil
    draftClosing = nil
    draftStep = 0
  }
  /// Moves the send-off on when the Send or Discard this device pressed is answered.
  private func advanceDraftSendOff() {
    guard draftSendOff == .pressed else { return }
    let discards = draftDiscards
    if state == (discards ? "dismissed" : "sent") {
      // Under Reduce Motion, or answered while the app was off screen, the card is simply settled.
      if reduceMotion || UIApplication.shared.applicationState != .active {
        draftSendOff = .idle
        return
      }
      Task { @MainActor in
        let hold = discards ? DraftSendOff.discardHold : DraftSendOff.minimumHold
        try? await Task.sleep(for: .seconds(max(0, hold - Date().timeIntervalSince(draftPressed))))
        guard draftSendOff == .pressed else { return }
        guard draftSettledHeight > 0, draftFormHeight > 0 else {
          draftSendOff = .idle
          return
        }
        let confirmed = Date()
        // False once the row has left the screen, or the app has: that ends the send-off and puts
        // the card right.
        @MainActor func wait(until offset: Double) async -> Bool {
          try? await Task.sleep(for: .seconds(max(0, confirmed.addingTimeInterval(offset).timeIntervalSinceNow)))
          if UIApplication.shared.applicationState != .active { leaveDraftSendOff() }
          return draftSendOff.confirmed
        }
        // A row can outlive its screen by a moment; nothing is felt once the chat has been left.
        @MainActor func felt() -> Bool { store.navigation.contains(message.channelId) }
        draftHeldHeight = draftFormHeight
        draftSendOff = .swallowing(confirmed)
        guard await wait(until: DraftSendOff.close.delay) else { return }
        // The card's height is stepped each frame by its own small timeline, so the row follows it
        // and the messages above travel with the card's top edge.
        draftHeldHeight = draftSettledHeight
        draftClosing = Date()
        draftStep = 1
        guard await wait(until: discards ? DraftSendOff.toss.from : DraftSendOff.windUp) else { return }
        draftSendOff = .slinging(confirmed)
        if discards {
          if felt() { NativeHaptics.draftSendSling(source: "draft.discard") }
          guard await wait(until: DraftSendOff.dip) else { return }
          draftDrops += 1
          guard await wait(until: DraftSendOff.settling.delay) else { return }
          withAnimation(.easeInOut(duration: DraftSendOff.settling.duration)) { draftStep = 2 }
          guard await wait(until: DraftSendOff.discardEnd) else { return }
        } else {
          guard await wait(until: DraftSendOff.sling) else { return }
          if felt() { NativeHaptics.draftSendSling(source: "draft.send") }
          draftSlings += 1
          withAnimation(.timingCurve(0.5, 0, 0.9, 0.4, duration: DraftSendOff.hit - DraftSendOff.sling)) { draftStep = 2 }
          guard await wait(until: DraftSendOff.hit) else { return }
          if felt() { NativeHaptics.draftSendHit(source: "draft.send") }
          draftStep = 3
          guard await wait(until: DraftSendOff.hit + DraftSendOff.stamp) else { return }
          withAnimation(.easeInOut(duration: DraftSendOff.relax)) { draftStep = 4 }
          guard await wait(until: DraftSendOff.end) else { return }
        }
        draftSendOff = .idle
        draftHeldHeight = nil
        draftClosing = nil
      }
    } else if state != "pending" && state != "sending" {
      draftSendOff = .idle
    } else if !draftOut, liveState == "pending" || (discards && liveState == "sending") {
      if reduceMotion {
        draftSendOff = .idle
        return
      }
      // The press came to nothing: the blob opens back into its pill. (A send the server took and
      // is still working on keeps its blob, whatever became of the request.)
      draftSendOff = .reverting
      Task { @MainActor in
        try? await Task.sleep(for: .seconds(0.32))
        if draftSendOff == .reverting { draftSendOff = .idle }
      }
    }
  }
  /// The card's state in the store, which a response updates before this row is redrawn.
  private var liveState: String {
    let value = store.messages(message.channelId).first { $0.id == message.id }?.metadata["cardState"].string ?? ""
    return value.isEmpty ? "pending" : value
  }
  @ViewBuilder private func draftSettled(draft: JSON, email: Bool, width: CGFloat) -> some View {
    let verification = draft["verification"]
    VStack(alignment: .leading, spacing: 10) {
      let recipient = email ? (draft["to"].array.first?.string ?? "") : draft["target"].string
      let summary = state == "unknown"
        ? "The send was interrupted — check your mailbox to see whether it went out"
        : (state == "sent" ? "Sent to " : "To ") + recipient
          + (email ? " — “" + draft["subject"].string + "”" : "")
      DisclosureGroup(isExpanded: $draftHistoryExpanded) {
        VStack(alignment: .leading, spacing: 0) {
          if email {
            DraftRow(label: "From", width: width) { DraftValue(draft["from"].string) }
            draftReplyRow(width: width)
            DraftRow(label: "To", width: width) { DraftValue(draft["to"].array.map(\.string).joined(separator: ", ")) }
            if !draft["cc"].array.isEmpty { DraftRow(label: "Cc", width: width) { DraftValue(draft["cc"].array.map(\.string).joined(separator: ", ")) } }
            DraftRow(label: "Subject", width: width) { DraftValue(draft["subject"].string) }
          } else {
            DraftRow(label: "Workspace", width: width) { DraftValue(verification["identity"].string) }
            DraftRow(label: "To", width: width) { DraftValue(draft["target"].string) }
          }
          Text(verbatim: draft["body"].string).font(.system(size: 16)).foregroundStyle(DraftPalette.text)
            .frame(maxWidth: .infinity, alignment: .leading).padding(10)
          let signature = verification["signatures"][draft["from"].string.lowercased()].string
          if !signature.isEmpty {
            Text(verbatim: signatureText(signature)).font(.system(size: 15)).padding(10)
          }
          draftAttachments
        }.background(DraftPalette.panel, in: RoundedRectangle(cornerRadius: 10))
      } label: {
        Text(verbatim: summary).font(.system(size: 15)).kerning(-0.15)
          .foregroundStyle(DraftPalette.secondary).lineLimit(1).truncationMode(.tail)
      }
      draftNotices
      if !meta["sentUnder"]["rule"].string.isEmpty || meta["sentUnder"]["draftingDisabled"].bool {
        HStack { Spacer(); approvalMenu }
      }
    }
  }
  /// "Send this message?": a bot's text waits until the user sends it from the named Mac.
  @ViewBuilder var imessageSend: some View {
    let send = meta["imessage"]
    let machine = send["machineLabel"].string.isEmpty ? "your Mac" : send["machineLabel"].string
    let name = send["recipientName"].string
    let handle = send["to"].string
    let recipient = send["recipientLabel"].string
    let text = send["text"].string
    let attachments = send["attachments"].array
    let sending = state == "sending" || draftSending
    let open = state == "pending" || state == "sending"
    // Send plays the draft card's send-off. There is no badge while the card is open, so the blob
    // hits the bare spot where the Sent badge will be, and the header changes as the card closes.
    let animating = draftAnimating
    let confirmed = draftSendOff.confirmed
    let waiting = animating && draftSendOff != .reverting
    let closed = animating ? draftStep >= 1 : !open
    let icon = Color(red: 0.2, green: 0.78, blue: 0.35)
    draftSendOffCard {
      ZStack(alignment: .leading) {
        if closed {
          HStack(spacing: 8) {
            Image(systemName: "message.fill").font(.system(size: 13)).foregroundStyle(icon)
            Text(verbatim: "Messages").font(.system(size: 15, weight: .medium)).kerning(-0.15).foregroundStyle(DraftPalette.text)
            Spacer(minLength: 0)
            // The Sent badge comes up under the green stamp the send-off leaves there.
            DraftStatusBadge(state: animating ? (draftDiscards ? "dismissed" : "sent") : state, anchorsFrame: animating)
              .opacity(animating && draftStep < (draftDiscards ? 2 : 4) ? 0 : 1)
          }.transition(.opacity)
        } else {
          HStack(spacing: 8) {
            Image(systemName: "message.fill").font(.system(size: 15)).foregroundStyle(icon)
            Text(verbatim: "Send this message?").font(.system(size: 15, weight: .medium)).kerning(-0.15)
              .foregroundStyle(DraftPalette.text).lineLimit(1)
          }
          .frame(maxWidth: animating ? .infinity : nil, alignment: .leading)
          .overlay(alignment: .trailing) {
            // Where the Sent badge will be, for the blob to aim at while it waits.
            if animating { DraftStatusBadge(state: "sent", anchorsFrame: true).hidden() }
          }
          .transition(.opacity)
        }
      }
      // A crossfade for the send-off only; any other change of state swaps the header at once.
      .animation(animating ? .easeOut(duration: DraftSendOff.close.duration) : nil, value: closed)
      draftClosingSection(open: open) {
        imessageSettled(machine: machine, name: name.isEmpty ? recipient : name, text: text, attachments: attachments)
      } form: {
        VStack(alignment: .leading, spacing: 10) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: "To").font(.system(size: 13)).foregroundStyle(DraftPalette.tertiary)
            Text(verbatim: name.isEmpty ? (handle.isEmpty ? recipient : handle) : name)
              .font(.system(size: 15, weight: .medium)).foregroundStyle(DraftPalette.text).lineLimit(1)
            if !name.isEmpty, !handle.isEmpty {
              Text(verbatim: handle).font(.system(size: 15)).foregroundStyle(DraftPalette.secondary).lineLimit(1)
            }
          }.opacity(confirmed ? 0 : 1)
          // The bubble goes into the blob (the files do, when there is no text); the rest fades.
          let blob = CGSize(width: draftBlobX, height: draftPayloadHeight + 27)
          VStack(alignment: .leading, spacing: 10) {
            if !text.isEmpty {
              HStack {
                Spacer(minLength: 40)
                Text(verbatim: text).font(.system(size: 16)).foregroundStyle(.white)
                  .fixedSize(horizontal: false, vertical: true)
                  .padding(.horizontal, 12).padding(.vertical, 7)
                  .background(Color(red: 0.04, green: 0.52, blue: 1), in: RoundedRectangle(cornerRadius: 18))
              }.modifier(DraftSwallowed(swallowed: confirmed, anchor: .topLeading, blob: blob))
            }
            if !attachments.isEmpty {
              VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(attachments.enumerated()), id: \.offset) { _, file in
                  HStack(spacing: 8) {
                    Image(systemName: "paperclip")
                    Text(verbatim: file["fileName"].string).lineLimit(2)
                    Spacer(minLength: 0)
                    Text(verbatim: ByteCountFormatter.string(fromByteCount: Int64(file["byteSize"].int), countStyle: .file))
                  }.font(.system(size: 13)).foregroundStyle(DraftPalette.secondary)
                }
              }
              .modifier(DraftSwallowed(swallowed: confirmed && text.isEmpty, anchor: .topLeading, blob: blob))
              .opacity(confirmed && !text.isEmpty ? 0 : 1)
            }
            DraftNote("The message will be sent from " + machine).opacity(confirmed ? 0 : 1)
            if !meta["sendError"].string.isEmpty { DraftNote(meta["sendError"].string, alert: true).opacity(confirmed ? 0 : 1) }
          }
          .background { if animating { DraftHeightReader(height: $draftPayloadHeight) } }
          let allowName = name.isEmpty ? handle : name
          let allowable = send["allowable"].bool && !handle.isEmpty
          // One row when it fits; otherwise Send and Discard stay together and Always allow goes below.
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
              imessageSendButton(sending: sending)
              if allowable { imessageAllowButton(allowName, sending: sending) }
              imessageDiscardButton(sending: sending)
            }
            VStack(alignment: .leading, spacing: 8) {
              HStack(spacing: 8) { imessageSendButton(sending: sending); imessageDiscardButton(sending: sending) }
              if allowable { imessageAllowButton(allowName, sending: sending) }
            }
          }.animation(.easeOut(duration: 0.12), value: waiting)
        }
        .animation(.easeOut(duration: DraftSendOff.gulp), value: confirmed)
      }
    }
  }
  @ViewBuilder private func imessageSettled(machine: String, name: String, text: String, attachments: [JSON]) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      let line = text.split(separator: "\n").first.map(String.init) ?? text
      let files = attachments.map { $0["fileName"].string }.joined(separator: ", ")
      let detail = [line.isEmpty ? "" : "“" + line + "”", files].filter { !$0.isEmpty }.joined(separator: " · ")
      let summary = state == "unknown"
        ? "The send was interrupted — check Messages on " + machine + " to see whether it went out"
        : (state == "sent" ? "Sent to " : "To ") + name + " — " + detail
      Text(verbatim: summary).font(.system(size: 15)).kerning(-0.15)
        .foregroundStyle(DraftPalette.secondary).lineLimit(1).truncationMode(.tail)
      if state == "sent", !meta["allowedRecipient"].string.isEmpty {
        DraftNote("Later messages to " + name + " from this computer won't ask")
      } else if state == "sent", meta["sentUnder"].bool {
        DraftNote("Sent without asking, as allowed on " + machine)
      }
      if state == "failed", !meta["sendError"].string.isEmpty { DraftNote(meta["sendError"].string, alert: true) }
    }
  }
  private func imessageSendButton(sending: Bool) -> some View {
    let animating = draftAnimating, plainSending = sending && !animating
    return Button {
      act("imessage-send", body: ["action": .string("send")])
    } label: {
      HStack(spacing: 6) {
        if plainSending { LoadingOrb(size: 14, label: "Sending") }
        Text(plainSending ? "Sending…" : "Send")
      }
    }.buttonStyle(DraftButtonStyle(primary: true, sending: plainSending)).disabled(sending || draftOut)
      .modifier(DraftSendOffPill(
        pressed: !draftDiscards, animating: animating, waiting: animating && draftSendOff != .reverting))
      .accessibilityIdentifier("imessage-send-button")
  }
  private func imessageAllowButton(_ name: String, sending: Bool) -> some View {
    Button("Always allow " + name) { act("imessage-send", body: ["action": .string("allow")]) }
      .buttonStyle(DraftButtonStyle(primary: false, sending: false)).lineLimit(1).disabled(sending || draftOut)
      .opacity(draftAnimating && draftSendOff != .reverting ? 0 : 1)
  }
  private func imessageDiscardButton(sending: Bool) -> some View {
    Button("Discard") { act("imessage-send", body: ["action": .string("cancel")]) }
      .buttonStyle(DraftButtonStyle(primary: false, sending: false)).disabled(sending || draftOut)
      .modifier(DraftSendOffPill(
        pressed: draftDiscards, animating: draftAnimating, waiting: draftAnimating && draftSendOff != .reverting,
        start: $draftDiscardX))
  }
  @ViewBuilder var sharedTemplate: some View {
    let template = meta["template"]
    Text(template["recipe"]["profile"]["name"].string).font(.headline)
    Text(template["recipe"]["profile"]["description"].string)
    DisclosureGroup("Complete template") { Text(template["recipe"].pretty).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
    ShareLink("Export template", item: template["recipe"].pretty)
    Text(meta["outcomeText"].string.isEmpty ? (state == "draft" ? "Unpublished" : state.capitalized) : meta["outcomeText"].string)
    if state == "draft" {
      Text("Draft: only you can see it until you publish").font(.footnote).foregroundStyle(NativePalette.muted)
      Button(busy ? "Publishing…" : "Publish") { templateAction("publish") }
    }
    if state == "published" {
      Button("Create a bot from this template") { templateAction("import") }
      Button("Unpublish") { templateAction("unpublish") }
    }
  }
  func templateAction(_ action: String) {
    act("bot-template", body: ["action": .string(action), "clientId": .string(importID)])
  }
  private func draftEdits() -> [String: JSON] {
    var edits: [String: JSON] = ["body": .string(bodyText)]
    if draftIsEmail {
      edits["subject"] = .string(subject)
      edits["to"] = .array(Self.addresses(to).map { .string($0) })
      edits["cc"] = .array(Self.addresses(cc).map { .string($0) })
      if fromAddress.lowercased() != meta["draft"]["from"].string.lowercased() {
        edits["from"] = .string(fromAddress)
      }
    }
    return edits
  }
  func draftAction(_ action: String) {
    act("external-draft", body: ["action": .string(action), "edits": .object(draftEdits())])
  }
  func setDraftApproval(_ mode: String) {
    var body: [String: JSON] = ["action": .string("approval"), "mode": .string(mode)]
    if state == "pending" { body["edits"] = .object(draftEdits()) }
    let previous = draftMode
    draftNotice = nil
    Task {
      do {
        _ = try await store.request(
          "/api/v0/channel-messages/\(API.segment(message.id))/external-draft", method: "POST",
          body: .object(body))
        draftNotice = Self.approvalNotice(from: previous, to: mode)
      } catch {
        failure = "Couldn't save. Try again."
      }
    }
  }
  func act(_ suffix: String, body: [String: JSON] = [:], clearSecrets: Bool = false) {
    guard !busy else { return }
    if suffix.hasPrefix("widget") { NativeHaptics.play(.light, source: "widget.submit") }
    busy = true
    failure = nil
    if store.draftPressFailures[message.id] != nil { store.draftPressFailures[message.id] = nil }
    var payload = body
    let action = suffix + ":" + (body["action"]?.string ?? "") + ":" + (body["mode"]?.string ?? "")
      + (suffix == "widget-response" ? ":" + (body["value"]?.string ?? "") : "")
    if lastAction != action {
      lastAction = action
      requestID = UUID().uuidString
    }
    if payload["clientId"] == nil { payload["clientId"] = .string(requestID) }
    if suffix == "external-draft" || suffix == "imessage-send", ["send", "allow"].contains(body["action"]?.string ?? "") {
      draftSending = true
      // "Always allow" on a text keeps its plain spinner.
      if suffix == "external-draft" || body["action"]?.string == "send" { pressDraftSendOff(discards: false) }
    } else if suffix == "external-draft" || suffix == "imessage-send", body["action"]?.string == "cancel" {
      pressDraftSendOff(discards: true)
    }
    Task {
      defer {
        busy = false
        draftSending = false
        if draftOut { store.draftPresses[message.id] = nil }
      }
      do {
        let result = try await store.request(
          "/api/v0/channel-messages/\(API.segment(message.id))/\(suffix)", method: "POST",
          body: .object(payload))
        if let updated = try? result["message"].decode(Message.self) {
          let current = store.messages(updated.channelId).first { $0.id == updated.id }
          let currentState = current?.metadata["cardState"].string ?? "pending"
          let settled = !currentState.isEmpty && currentState != "pending" && currentState != "sending"
          // A response can arrive after another device's terminal update.
          if suffix != "external-draft" || !settled {
            store.merge([updated], channel: updated.channelId)
            store.persist()
          }
        }
        // A draft reports its outcome in the returned card (sent, reopened with an error, unchanged).
        guard suffix == "external-draft" || suffix == "imessage-send"
          || WidgetMutationReceipt.accepted(result, action: suffix, clientID: payload["clientId"]?.string ?? "", value: payload["value"] ?? .null) else {
          NativeHaptics.play(.error, source: "rich-action.result")
          failure = "This action is no longer available. The card has been refreshed."
          return
        }
        if suffix == "computer-handoff" {
          NativeHaptics.play(.light, source: "computer.handoff-start")
        }
        if (suffix == "computer-handoff" && body["action"]?.string == "start")
          || (suffix == "user-form" && body["mode"]?.string == "escalated") {
          presentComputer()
        }
        if suffix == "secret" || suffix == "secret-submit" || suffix == "secret-request" {
          NativeHaptics.play(.success, source: "secret.submit")
        }
        if clearSecrets {
          secret = ""
          formValues = [:]
        }
        requestID = UUID().uuidString
      } catch {
        let current = store.messages(message.channelId).first { $0.id == message.id }
        let confirmed = ["sent", "dismissed"].contains(current?.metadata["cardState"].string ?? "")
        if (suffix == "external-draft" || suffix == "imessage-send") && confirmed {
          // The response may be lost after its live update already confirmed success.
          failure = nil
        } else {
          NativeHaptics.failure(error, source: "rich-action.result")
          failure = UserFacingError.message(error)
          // The row may have been replaced since the press; the failure is the card's, not the row's.
          if draftOut { store.draftPressFailures[message.id] = failure }
        }
      }
    }
  }
}

/// Signature HTML from the mail provider, shown as plain text.
func signatureText(_ html: String) -> String {
  var text = html.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
  text = text.replacingOccurrences(of: "</(div|p|li|tr|h[1-6])>", with: "\n", options: [.regularExpression, .caseInsensitive])
  text = text.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
  for (entity, value) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&amp;", "&")] {
    text = text.replacingOccurrences(of: entity, with: value)
  }
  return text.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Draft card colors: the reference card's token values (ink #1c1c1c / #f5f5f5 at fixed alphas).
enum DraftPalette {
  static func color(_ light: String, _ dark: String) -> Color {
    Color(uiColor: UIColor { traits in
      let hex = traits.userInterfaceStyle == .dark ? dark : light
      let value = UInt64(hex, radix: 16) ?? 0
      let rgba = hex.count == 8 ? value : (value << 8) | 0xFF
      return UIColor(
        red: CGFloat((rgba >> 24) & 255) / 255, green: CGFloat((rgba >> 16) & 255) / 255,
        blue: CGFloat((rgba >> 8) & 255) / 255, alpha: CGFloat(rgba & 255) / 255)
    })
  }
  static let text = color("1c1c1c", "f5f5f5")
  static let secondary = color("1c1c1cad", "f5f5f5a8")
  static let tertiary = color("1c1c1c8f", "f5f5f58a")
  static let quaternary = color("1c1c1c66", "f5f5f561")
  static let inverted = color("fcfcfc", "121212")
  static let iconSecondary = color("1c1c1ca8", "f5f5f5a3")
  /// One step lighter than the card, as in the reference (#1f1f1f on #1b1b1b).
  static let panel = color("ffffff", "242424")
  static let divider = color("1c1c1c14", "f5f5f50f")
  static let outline = color("1c1c1c1f", "f5f5f51a")
  static let fill = color("1c1c1c0f", "f5f5f50a")
  static let fillPressed = color("1c1c1c1a", "f5f5f514")
  static let fillFaint = color("1c1c1c0a", "f5f5f505")
  static let primary = color("1c1c1c", "f5f5f5")
  static let primaryPressed = color("1c1c1cad", "f5f5f5a8")
  static let primaryDisabled = color("1c1c1c26", "f5f5f521")
  static let green = color("00854a", "00ba69")
  static let greenFill = color("14c16f17", "14c37012")
  static let yellow = color("aa6300", "e28600")
  static let yellowFill = color("da830e38", "c8770c38")
  static let danger = color("cd2834", "ff6463")
  /// The Discard blob: a solid, muted grey.
  static let discarding = color("bdbdbd", "5c5c5c")
}

private struct Line: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    path.move(to: CGPoint(x: rect.minX, y: rect.midY))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
    return path
  }
}

/// A label and value on one grid row, with the reference card's hairline divider.
private struct DraftRow<Content: View>: View {
  let label: String
  let width: CGFloat
  @ViewBuilder let content: Content
  var body: some View {
    // Top-aligned with a 2pt nudge: lines the 13pt label up with the 15pt value's first line,
    // which a baseline row can't do for an empty multi-line field.
    HStack(alignment: .top, spacing: 8) {
      Text(verbatim: label).font(.system(size: 13)).foregroundStyle(DraftPalette.tertiary)
        .lineLimit(1).frame(width: width, alignment: .leading).padding(.top, 2)
      content.frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, 8).padding(.horizontal, 10).contentShape(Rectangle())
    .overlay(alignment: .bottom) {
      DraftPalette.divider.frame(height: 1)
    }
  }
}

private struct DraftValue: View {
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(verbatim: text).font(.system(size: 15)).kerning(-0.15).foregroundStyle(DraftPalette.secondary)
      .lineLimit(1)
  }
}

private struct DraftNote: View {
  let text: String
  var alert = false
  init(_ text: String, alert: Bool = false) {
    self.text = text
    self.alert = alert
  }
  var body: some View {
    Text(verbatim: text).font(.system(size: 14)).kerning(-0.08)
      .foregroundStyle(alert ? DraftPalette.danger : DraftPalette.tertiary)
      .accessibilityAddTraits(alert ? .isStaticText : [])
  }
}

/// The draft's height, stepped frame by frame while its card closes. A row resize in the history
/// interrupts an animated height and an animated row cannot be kept in step with the card, so this
/// one value is laid out per frame, for the length of the close only; the timeline is paused otherwise.
private struct DraftClosingHeight: ViewModifier {
  let height: CGFloat?
  let closing: Date?
  let from: CGFloat
  private static let curve = UnitCurve.bezier(
    startControlPoint: UnitPoint(x: 0.2, y: 0.9), endControlPoint: UnitPoint(x: 0.1, y: 1))
  func body(content: Content) -> some View {
    TimelineView(.animation(paused: closing == nil)) { timeline in
      let progress = closing.map { min(1, max(0, timeline.date.timeIntervalSince($0) / DraftSendOff.close.duration)) } ?? 1
      content.frame(
        height: height.map { from + ($0 - from) * (closing == nil ? 1 : Self.curve.value(at: progress)) },
        alignment: .top)
    }
  }
}

/// A button of a draft card during a send-off: the pressed one is drawn by the send-off itself,
/// from the tap until the blob has gone or is the pill again, and tells it where the pill is; the
/// others are out of the way while the blob waits and flies.
private struct DraftSendOffPill: ViewModifier {
  /// The card's coordinate space.
  static let card = "draft-card"
  let pressed: Bool
  let animating: Bool
  let waiting: Bool
  /// Set to where the pill starts across the card, when it is not the card's first.
  var start: Binding<CGFloat>?
  func body(content: Content) -> some View {
    content
      .opacity((pressed ? animating : waiting) ? 0 : 1)
      .background {
        if pressed, animating {
          Color.clear.anchorPreference(key: DraftSendAnchors.self, value: .bounds) { ["pill": $0] }
          if let start {
            GeometryReader { proxy in
              let x = proxy.frame(in: .named(Self.card)).minX
              Color.clear.onAppear { start.wrappedValue = x }.onChange(of: x) { _, value in start.wrappedValue = value }
            }
          }
        }
      }
  }
}

/// What the blob swallows: scaled down onto the blob's centre, which is the Send pill's leading end
/// a row below, and opaque until it is nearly there.
private struct DraftSwallowed: ViewModifier {
  let swallowed: Bool
  var anchor = UnitPoint.bottomLeading
  /// The blob's centre, from the anchor.
  var blob = CGSize(width: 17, height: 27)
  func body(content: Content) -> some View {
    content
      .scaleEffect(swallowed ? 0.08 : 1, anchor: anchor)
      .offset(x: swallowed ? 0.92 * blob.width : 0, y: swallowed ? 0.92 * blob.height : 0)
      .animation(.timingCurve(0.6, 0, 0.9, 0.4, duration: DraftSendOff.gulp), value: swallowed)
      .opacity(swallowed ? 0 : 1)
      .animation(.linear(duration: 0.06).delay(DraftSendOff.gulp - 0.06), value: swallowed)
  }
}

/// Reports a section's height, only while a send-off needs it.
private struct DraftHeightReader: View {
  @Binding var height: CGFloat
  var body: some View {
    GeometryReader { proxy in
      Color.clear.onAppear { height = proxy.size.height }
        .onChange(of: proxy.size.height) { _, value in height = value }
    }
  }
}

/// Send (solid) and Discard (tinted with an outline), as capsule buttons.
private struct DraftButtonStyle: ButtonStyle {
  let primary: Bool
  let sending: Bool
  @Environment(\.isEnabled) private var isEnabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 15))
      .foregroundStyle(primary ? (sending ? DraftPalette.quaternary : DraftPalette.inverted) : DraftPalette.text)
      .padding(.horizontal, 14).frame(height: 34)
      .background(
        primary
          ? (sending ? DraftPalette.primaryDisabled : configuration.isPressed ? DraftPalette.primaryPressed : DraftPalette.primary)
          : (configuration.isPressed ? DraftPalette.fillPressed : DraftPalette.fill),
        in: Capsule())
      .overlay { if !primary { Capsule().strokeBorder(DraftPalette.outline, lineWidth: 1) } }
      .opacity(isEnabled || sending ? 1 : 0.56)
  }
}

/// The card's state as status text: Ready to send, Sent, and so on.
struct DraftStatusBadge: View {
  let state: String
  /// Publishes the badge's frame for the send-off, which lands on it.
  var anchorsFrame = false
  /// The send-off's stamp: the label alone, knocked out of solid green.
  var stamped = false
  static func label(_ state: String) -> String {
    switch state {
    case "pending": "Ready to send"
    case "sending": "Sending"
    case "sent": "Sent"
    case "dismissed": "Discarded"
    case "failed", "draft-created": "Message not delivered"
    default: "Unconfirmed"
    }
  }
  var body: some View {
    let ready = state == "pending" || state == "sending"
    let sent = state == "sent"
    let warning = ["failed", "draft-created"].contains(state)
    let ink = stamped ? DraftPalette.inverted : sent ? DraftPalette.green : warning ? DraftPalette.yellow : ready ? DraftPalette.secondary : DraftPalette.tertiary
    HStack(spacing: ready ? 6 : 4) {
      if state != "unknown" {
        Circle().fill(stamped ? ink : sent ? DraftPalette.green : warning ? DraftPalette.yellow : DraftPalette.tertiary)
          .frame(width: 6, height: 6)
      }
      Text(Self.label(state)).font(.system(size: 12, weight: .medium))
    }
    .foregroundStyle(ink)
    .padding(.horizontal, ready ? 8 : 7).padding(.vertical, 2)
    .background(
      stamped ? Color.clear : sent ? DraftPalette.greenFill : warning ? DraftPalette.yellowFill : DraftPalette.fillFaint,
      in: Capsule())
    .background {
      if anchorsFrame { Color.clear.anchorPreference(key: DraftSendAnchors.self, value: .bounds) { ["badge": $0] } }
    }
  }
}

private struct WidgetSubmitStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.opacity(configuration.isPressed ? 0.8 : 1)
  }
}
