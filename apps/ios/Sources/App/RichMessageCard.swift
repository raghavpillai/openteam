import SwiftUI

struct ApprovalCard: View {
  @Environment(AppStore.self) private var store
  let approval: Approval
  @State private var excluded: Set<String> = []
  private var items: [JSON] { approval.details["presentation"]["items"].array }
  private var cookieImport: Bool {
    approval.details["presentation"]["kind"].string == "cookie-import"
  }
  private var pending: Bool { ApprovalPresentation.isPending(approval) }
  private func key(_ item: JSON) -> String {
    ApprovalPresentation.siteKey(profileID: item["profileId"].string, origin: item["origin"].string)
  }
  private var selected: [String] { items.map(key).filter { !excluded.contains($0) } }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title).font(.body.weight(.medium))
      let detail = approval.details
      ForEach(["description", "summary", "reason", "effect", "machineLabel"], id: \.self) { key in
        if !detail[key].string.isEmpty {
          Text(detail[key].string).font(["description", "summary"].contains(key) ? .body : .subheadline)
            .foregroundStyle(["description", "summary"].contains(key) ? NativePalette.text : NativePalette.muted)
        }
      }
      if cookieImport {
        let profiles = Array(Set(items.map { $0["profileId"].string })).sorted()
        ForEach(profiles, id: \.self) { profile in
          let group = items.filter { $0["profileId"].string == profile }
          VStack(alignment: .leading, spacing: 10) {
            let name = group.first?["profileDisplayName"].string ?? profile
            if pending {
              Toggle(
                name,
                isOn: Binding(
                  get: { group.allSatisfy { !excluded.contains(key($0)) } },
                  set: { value in
                    for item in group {
                      if value { excluded.remove(key(item)) } else { excluded.insert(key(item)) }
                    }
                  })
              ).fontWeight(.semibold).tint(NativePalette.toggle)
            } else {
              Text(name).font(.headline)
            }
            ForEach(group, id: \.self) { item in
              if pending {
                Toggle(
                  item["origin"].string,
                  isOn: Binding(
                    get: { !excluded.contains(key(item)) },
                    set: { value in
                      if value { excluded.remove(key(item)) } else { excluded.insert(key(item)) }
                    })
                ).tint(NativePalette.toggle).accessibilityIdentifier(
                  "approval-site-" + item["profileId"].string + "-" + item["origin"].string)
              } else if detail["selectedItems"] == .null
                || detail["selectedItems"].array.contains(.string(key(item)))
              {
                Label(item["origin"].string, systemImage: "globe")
              }
            }
          }
        }
        if pending {
          Text("\(selected.count) sites selected · up to 32 per approval").font(.caption)
            .foregroundStyle(NativePalette.muted)
        }
      }
      if detail["arguments"] != .null {
        DisclosureGroup("Action details") {
          Text(detail["arguments"].pretty).font(.system(.caption, design: .monospaced))
            .textSelection(.enabled)
        }
      }
      if pending {
        HStack {
          Button("Deny", role: .destructive) { act("decline") }.buttonStyle(.bordered)
          Spacer()
          Button("Approve once") { act("accept") }.buttonStyle(PrimaryActionStyle())
            .accessibilityIdentifier("approve-" + approval.id)
            .disabled(cookieImport && (selected.isEmpty || selected.count > 32))
        }
        if detail["supportsAlwaysAllow"].bool {
          if !detail["proposedRule"].string.isEmpty {
            Text("Always allow: " + detail["proposedRule"].string).font(.caption)
          }
          Button("Always allow") { act("always_allow") }.disabled(
            cookieImport && (selected.isEmpty || selected.count > 32))
        }
        if detail["supportsNever"].bool {
          Button("Never allow", role: .destructive) { act("never") }
        }
      } else {
        let status = ApprovalPresentation.status(approval)
        HStack(spacing: 6) {
          if status == "Running" { ProgressView().tint(receiptColor(status)) }
          Label(status, systemImage: ["Failed", "Denied", "Cancelled", "Expired"].contains(status)
            ? "xmark.circle.fill" : "checkmark.circle.fill")
        }.font(.system(size: 15, weight: .medium)).foregroundStyle(receiptColor(status))
          .frame(maxWidth: .infinity).frame(minHeight: 38)
          .background(receiptColor(status).opacity(0.15), in: RoundedRectangle(cornerRadius: 10))

        if !detail["actionError"].string.isEmpty {
          Text(UserFacingError.message(APIError(detail["actionError"].string))).font(.footnote)
        }
      }
    }.padding(14).background(NativePalette.surface, in: RoundedRectangle(cornerRadius: 18))
      .disabled(store.busy.contains(path))
  }
  var title: String {
    [
      approval.details["title"].string, approval.details["toolName"].string,
      cookieImport ? "Chrome site access" : "Approval request",
    ].first { !$0.isEmpty }!
  }
  private func receiptColor(_ status: String) -> Color {
    if ["Failed", "Denied", "Cancelled", "Expired"].contains(status) { return NativePalette.widgetDanger }
    if status == "Running" { return NativePalette.link }
    return NativePalette.receiptCheck
  }
  var path: String { "/api/v0/approvals/\(API.segment(approval.id))/resolve" }
  func act(_ decision: String) {
    Task {
      var body: [String: JSON] = ["decision": .string(decision)]
      if cookieImport, ["accept", "always_allow"].contains(decision) {
        body["selectedItems"] = .array(selected.map(JSON.string))
      }
      await store.mutate(
        path, body: .object(body), successFeedback: .success, feedbackSource: "approval.resolve")
      if let id = store.activeChannel { await store.loadHistory(id) }
    }
  }
}

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
  private var supported: Bool {
    [
      "widget", "secret-request", "computer-handoff", "user-form", "external-draft",
      "review-action", "credential-request",
    ].contains(type)
  }
  var body: some View {
    if supported {
      VStack(alignment: .leading, spacing: type == "widget" ? 12.25 : 13) {
        if let failure { InlineFailure(message: failure) }
        switch type {
        case "widget": widget
        case "secret-request": secretRequest
        case "computer-handoff": handoff
        case "user-form": form
        case "external-draft": externalDraft
        case "review-action": review
        case "credential-request":
          Label("Saved login request", systemImage: "key").font(.headline)
          Text(meta["credential"]["site"].string)
          Text("Review the associated approval to continue.").font(.subheadline).foregroundStyle(
            NativePalette.muted)
        default: EmptyView()
        }
      }.padding(type == "widget" ? 14 : 16).background(
        NativePalette.surface, in: RoundedRectangle(cornerRadius: 18)
      )
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
      .onChange(of: bodyText) { _, _ in requestID = UUID().uuidString }
      .onChange(of: to) { _, _ in requestID = UUID().uuidString }
      .onChange(of: cc) { _, _ in requestID = UUID().uuidString }
      .onChange(of: saveToVault) { _, _ in requestID = UUID().uuidString }
      .onChange(of: subject) { _, _ in requestID = UUID().uuidString }
      .disabled(busy || store.busy.contains("/api/v0/channel-messages/\(API.segment(message.id))/widget-response"))
      .onAppear {
        bodyText = meta["draft"]["body"].string
        subject = meta["draft"]["subject"].string
        to = meta["draft"]["to"].array.map(\.string).joined(separator: ", ")
        cc = meta["draft"]["cc"].array.map(\.string).joined(separator: ", ")
      }
      .onDisappear {
        secret = ""
        formValues = [:]
      }
    }
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
          if index > 0 { NativePalette.separator.opacity(0.5).frame(height: 0.5) }
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
            HStack(alignment: .top, spacing: 9) {
              Text(index < 26 ? String(UnicodeScalar(65 + index)!) : String(index + 1))
                .font(.system(size: 13)).foregroundStyle(NativePalette.chatFaint)
                .frame(width: 20, height: 20)
                .background(NativePalette.surface, in: RoundedRectangle(cornerRadius: 5))
                .accessibilityHidden(true)
              VStack(alignment: .leading, spacing: 3.5) {
                Text(option["label"].string).font(.body)
                  .foregroundStyle(option["style"].string == "danger"
                    ? NativePalette.widgetDanger : NativePalette.text)
                if !option["description"].string.isEmpty {
                  Text(option["description"].string).font(.system(size: 14))
                    .foregroundStyle(NativePalette.chatMuted)
                }
              }.fixedSize(horizontal: false, vertical: true)
              Spacer(minLength: 0)
              if selected.contains(value) {
                Image(systemName: "checkmark").font(.system(size: 14))
                  .foregroundStyle(NativePalette.receiptCheck)
              }
            }.padding(.horizontal, 10).padding(.vertical, 10)
              .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
              .contentShape(Rectangle())
          }.buttonStyle(.plain).disabled(dismissed)
            .accessibilityLabel(option["label"].string)
            .accessibilityValue(selected.contains(value) ? "Selected" : "")
        }
      }.background(NativePalette.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(NativePalette.separator.opacity(0.5), lineWidth: 0.5))
        .opacity(dismissed ? 0.35 : 1)
      if dismissed {
        Text("dismissed").font(.system(size: 12)).foregroundStyle(NativePalette.chatFaint)
          .accessibilityIdentifier("widget-dismissed-" + message.id)
      } else {
        if widget["allowCustom"].bool {
          Text("Or answer in the chat below").font(.system(size: 14))
            .foregroundStyle(NativePalette.chatFaint)
        }
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
  @ViewBuilder var externalDraft: some View {
    let draft = meta["draft"]
    Text(draft["platform"].string == "email" ? "Review email" : "Review Slack message").font(
      .headline)
    Text(
      "Account: "
        + (draft["verification"]["identity"].string.isEmpty
          ? draft["providerIdentifier"].string : draft["verification"]["identity"].string)
    ).font(.caption)
    if draft["platform"].string == "slack" {
      Text("To: " + draft["target"].string).font(.subheadline)
    }
    if state == "pending" {
      if draft["platform"].string == "email" {
        TextField("To", text: $to).textFieldStyle(.roundedBorder).textInputAutocapitalization(
          .never)
        TextField("Cc", text: $cc).textFieldStyle(.roundedBorder).textInputAutocapitalization(
          .never)
        TextField("Subject", text: $subject).textFieldStyle(.roundedBorder)
      }
      TextField("Message body", text: $bodyText, axis: .vertical).lineLimit(3...10).textFieldStyle(
        .roundedBorder)
      HStack {
        Button("Cancel") { act("external-draft", body: ["action": .string("cancel")]) }
        Spacer()
        Button("Save") { draftAction("save") }
        Button("Send") { draftAction("send") }.bold()
      }
    } else {
      Text(meta["outcomeText"].string.isEmpty ? state.capitalized : meta["outcomeText"].string)
    }
    if state == "sending" {
      Button("Check delivery") { act("external-draft", body: ["action": .string("refresh")]) }
    }
  }
  @ViewBuilder var review: some View {
    let review = meta["review"]
    let template = review["kind"].string == "template"
    Text(template ? review["recipe"]["profile"]["name"].string : "Review product feedback").font(
      .headline)
    Text(template ? review["recipe"]["profile"]["description"].string : review["message"].string)
    if template {
      DisclosureGroup("Complete template") {
        Text(review["recipe"].pretty).font(.system(.caption, design: .monospaced)).textSelection(
          .enabled)
      }
      ShareLink("Export template", item: review["recipe"].pretty)
    } else {
      Text("To: " + review["destination"].string).font(.caption)
    }
    if state == "pending" {
      HStack {
        Button("Cancel") { reviewAction("cancel") }
        Spacer()
        Button(template ? "Publish this version" : "Send feedback") { reviewAction("approve") }
      }
    } else {
      Text(meta["outcomeText"].string.isEmpty ? state.capitalized : meta["outcomeText"].string)
      if state == "sending" { Button("Check delivery") { reviewAction("refresh") } }
      if template && state == "published" {
        Button("Create a bot from this template") { reviewAction("import") }
        Button("Unpublish") { reviewAction("unpublish") }
      }
    }
  }
  func reviewAction(_ action: String) {
    act("review-action", body: ["action": .string(action), "clientId": .string(importID)])
  }
  func draftAction(_ action: String) {
    var edits: [String: JSON] = ["body": .string(bodyText)]
    if meta["draft"]["platform"].string == "email" {
      edits["subject"] = .string(subject)
      edits["to"] = .array(
        to.split(separator: ",").map { .string($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
          .filter { !$0.string.isEmpty })
      edits["cc"] = .array(
        cc.split(separator: ",").map { .string($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
          .filter { !$0.string.isEmpty })
    }
    act("external-draft", body: ["action": .string(action), "edits": .object(edits)])
  }
  func act(_ suffix: String, body: [String: JSON] = [:], clearSecrets: Bool = false) {
    guard !busy else { return }
    if suffix.hasPrefix("widget") { NativeHaptics.play(.light, source: "widget.submit") }
    busy = true
    failure = nil
    var payload = body
    let action = suffix + ":" + (body["action"]?.string ?? "") + ":" + (body["mode"]?.string ?? "")
      + (suffix == "widget-response" ? ":" + (body["value"]?.string ?? "") : "")
    if lastAction != action {
      lastAction = action
      requestID = UUID().uuidString
    }
    if payload["clientId"] == nil { payload["clientId"] = .string(requestID) }
    Task {
      defer { busy = false }
      do {
        let result = try await store.request(
          "/api/v0/channel-messages/\(API.segment(message.id))/\(suffix)", method: "POST",
          body: .object(payload))
        if let updated = try? result["message"].decode(Message.self) {
          store.merge([updated], channel: updated.channelId)
          store.persist()
        }
        guard WidgetMutationReceipt.accepted(result, action: suffix, clientID: payload["clientId"]?.string ?? "", value: payload["value"] ?? .null) else {
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
        NativeHaptics.failure(error, source: "rich-action.result")
        failure = UserFacingError.message(error)
      }
    }
  }
}

private struct WidgetSubmitStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.opacity(configuration.isPressed ? 0.8 : 1)
  }
}
