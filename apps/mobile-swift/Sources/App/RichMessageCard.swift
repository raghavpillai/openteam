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
    VStack(alignment: .leading, spacing: 14) {
      Label(title, systemImage: "checkmark.shield").font(.headline)
      let detail = approval.details
      ForEach(["description", "summary", "reason", "effect", "machineLabel"], id: \.self) { key in
        if !detail[key].string.isEmpty {
          Text(detail[key].string).font(.subheadline).foregroundStyle(NativePalette.muted)
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
        HStack {
          if status == "Running" { ProgressView() }
          Label(
            status,
            systemImage: status == "Failed"
              ? "exclamationmark.circle"
              : status == "Completed" ? "checkmark.circle" : "checkmark.shield")
        }.foregroundStyle(status == "Failed" ? NativePalette.destructive : NativePalette.muted)
          .accessibilityIdentifier("approval-receipt-" + approval.id)
        if !detail["actionError"].string.isEmpty {
          Text(UserFacingError.message(APIError(detail["actionError"].string))).font(.footnote)
        }
      }
    }.padding(18).background(NativePalette.surface, in: RoundedRectangle(cornerRadius: 20))
      .disabled(store.busy.contains(path))
  }
  var title: String {
    [
      approval.details["title"].string, approval.details["toolName"].string,
      cookieImport ? "Chrome site access" : "Approval required",
    ].first { !$0.isEmpty }!
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
  @Environment(MessageModalPresenter.self) private var modals
  @Environment(AppStore.self) private var store
  let message: Message
  @State private var selected: Set<String> = []
  @State private var custom = ""
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
      VStack(alignment: .leading, spacing: 13) {
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
      }.padding(16).background(
        NativePalette.surface, in: RoundedRectangle(cornerRadius: 18)
      )
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
      .onChange(of: custom) { _, _ in requestID = UUID().uuidString }
      .onChange(of: bodyText) { _, _ in requestID = UUID().uuidString }
      .onChange(of: to) { _, _ in requestID = UUID().uuidString }
      .onChange(of: cc) { _, _ in requestID = UUID().uuidString }
      .onChange(of: saveToVault) { _, _ in requestID = UUID().uuidString }
      .onChange(of: subject) { _, _ in requestID = UUID().uuidString }
      .disabled(busy)
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
    Text(widget["prompt"].string).font(.headline)
    if !widget["helpText"].string.isEmpty {
      Text(widget["helpText"].string).font(.subheadline).foregroundStyle(NativePalette.muted)
    }
    if !meta["respondedValue"].string.isEmpty {
      Text(meta["respondedValue"].string)
    } else if meta["widgetDismissed"].bool {
      Text("Dismissed").foregroundStyle(NativePalette.muted)
    } else {
      ForEach(Array(widget["options"].array.enumerated()), id: \.offset) { _, option in
        let value = option["value"].string.isEmpty ? option["label"].string : option["value"].string
        Button {
          if widget["multiSelect"].bool {
            NativeHaptics.play(.selection, source: "widget.selection")
            if selected.contains(value) { selected.remove(value) } else { selected.insert(value) }
          } else {
            act("widget-response", body: ["value": .string(value)])
          }
        } label: {
          HStack {
            Text(option["label"].string)
            Spacer()
            if selected.contains(value) { Image(systemName: "checkmark") }
          }.frame(minHeight: 32)
        }.buttonStyle(.bordered)
      }
      if widget["allowCustom"].bool {
        TextField("Your answer", text: $custom, axis: .vertical).textFieldStyle(.roundedBorder)
      }
      if widget["multiSelect"].bool || widget["allowCustom"].bool {
        Button("Submit") {
          let values =
            widget["options"].array.map {
              $0["value"].string.isEmpty ? $0["label"].string : $0["value"].string
            }.filter(selected.contains)
            + (custom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              ? [] : [custom.trimmingCharacters(in: .whitespacesAndNewlines)])
          act("widget-response", body: ["value": .string(values.joined(separator: "\n"))])
        }.disabled(selected.isEmpty && custom.isEmpty)
      }
      Button("Dismiss") { act("widget-dismiss") }.font(.subheadline).foregroundStyle(
        NativePalette.muted)
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
        guard result["accepted"] != .bool(false) else {
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
