import Foundation

extension AppStore {
  /// Custom widget answers use the normal composer. Keep the draft and request
  /// identity until the server confirms acceptance, including after a lost reply.
  func answerWidgetFromComposer(_ channel: Channel, draftKey: String) async -> Bool {
    var current = draft(draftKey)
    guard current.replyTo == nil, current.attachments.isEmpty,
      (current.stagedFiles ?? []).isEmpty else { return false }
    let response: WidgetComposerResponse
    if let saved = current.widgetResponse { response = saved }
    else {
      guard let card = messages(channel.id).last(where: {
        $0.metadata["type"].string == "widget" && $0.metadata["widget"]["allowCustom"].bool
          && $0.metadata["respondedValue"] == .null && !$0.metadata["widgetDismissed"].bool
          && !$0.metadata["branched"].bool
      }) else { return false }
      let widget = card.metadata["widget"]
      let selected = Set(current.widgetSelections?[card.id] ?? [])
      let choices = widget["multiSelect"].bool ? widget["options"].array.map {
        $0["value"].string.isEmpty ? $0["label"].string : $0["value"].string
      }.filter(selected.contains) : []
      response = WidgetComposerResponse(messageID: card.id,
        value: (choices + [current.text.trimmingCharacters(in: .whitespacesAndNewlines)]).joined(separator: "\n"),
        clientID: UUID().uuidString)
      current.widgetResponse = response
      saveDraft(current, channel: draftKey)
      flushPersistence()
    }
    let path = "/api/v0/channel-messages/\(API.segment(response.messageID))/widget-response"
    guard !busy.contains(path) else { return true }
    guard let session = api else { error = "Connect to send this answer. Your draft is saved."; return true }
    busy.insert(path)
    defer { busy.remove(path) }
    do {
      let result = try await request(path, method: "POST", body: .object([
        "value": .string(response.value), "clientId": .string(response.clientID),
      ]))
      guard api?.baseURL == session.baseURL, api?.token == session.token else { return true }
      if let updated = try? result["message"].decode(Message.self) {
        merge([updated], channel: channel.id)
      }
      guard WidgetMutationReceipt.accepted(result, action: "widget-response", clientID: response.clientID, value: .string(response.value)) else {
        error = "This question is no longer available. Your draft is saved."
        return true
      }
      if draft(draftKey) == current { saveDraft(Draft(), channel: draftKey) }
      NativeHaptics.play(.light, source: "widget.submit")
      await loadHistory(channel.id)
    } catch {
      guard api?.baseURL == session.baseURL, api?.token == session.token else { return true }
      handle(error)
    }
    return true
  }
}
