import Foundation

/// Compile with the actual AppStore/Core sources and -D DEBUG; pass --ui-testing.
/// Uses a separate disposable fixture and AppStore's temporary QA disk scope.
@main struct StoreAudit {
  @MainActor static func main() async throws {
    guard ProcessInfo.processInfo.arguments.contains("--ui-testing") else {
      fatalError("This audit must use the isolated UI-testing store.")
    }
    let api = try API(server: "http://127.0.0.1:20012")
    _ = try await api.request("/__qa/reset", method: "POST")
    let store = AppStore()
    await store.start()
    store.setForeground(false)
    guard let first = store.channel("channel-research"), let second = store.channel("channel-ops") else {
      throw APIError("Missing disposable audit conversations.")
    }
    _ = try await api.request("/__qa/control", method: "POST", body: .object(["offline": .bool(true)]))
    await store.refresh()
    var draft = Draft()
    draft.text = "QA message for a bot deleted on another device"
    store.saveDraft(draft, channel: first.id)
    await store.enqueue(first)
    draft.text = "QA message for a still-existing bot"
    store.saveDraft(draft, channel: second.id)
    await store.enqueue(second)
    let queuedBefore = store.state.outbox.count
    _ = try await api.request("/__qa/control", method: "POST", body: .object(["offline": .bool(false)]))
    _ = try await api.request("/api/v0/bots/bot-research", method: "DELETE")
    await store.refresh()
    let remaining = store.state.outbox.map { ["channelId": $0.channelId, "failure": $0.failure ?? "none"] }
    let blocked = !store.messages(second.id).contains { $0.content == draft.text }
    if let missing = store.state.outbox.first { store.discard(missing.id) }
    await store.flush()
    let deliveredAfterManualDiscard = store.messages(second.id).contains { $0.content == draft.text }
    let report: [String: Any] = [
      "finding": "QA-07", "source": "Actual AppStore compiled for macOS with isolated QA persistence",
      "queuedBeforeDeletion": queuedBefore, "onlineAfterReconnect": store.online,
      "deletedConversationAbsent": store.channel(first.id) == nil, "queueAfterReconnect": remaining,
      "validMessageBlocked": blocked, "deliveredAfterProgrammaticDiscardOfMissingChannel": deliveredAfterManualDiscard,
      "note": "There is no global outbox screen in the app from which to discard this missing-channel entry."
    ]
    let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    guard queuedBefore == 2, blocked, deliveredAfterManualDiscard else {
      throw APIError("The suspected outbox defect did not reproduce.")
    }
  }
}
