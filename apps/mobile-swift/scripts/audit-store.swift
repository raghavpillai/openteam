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
    guard let first = store.channel("channel-research"), let second = store.channel("channel-ops")
    else {
      throw APIError("Missing disposable audit conversations.")
    }
    _ = try await api.request(
      "/__qa/control", method: "POST", body: .object(["offline": .bool(true)]))
    await store.refresh()
    var draft = Draft()
    draft.text = "QA message for a bot deleted on another device"
    store.saveDraft(draft, channel: first.id)
    try store.stage(
      Data("Preserved attachment".utf8), name: "queued-proof.txt", mime: "text/plain",
      channel: first.id)
    await store.enqueue(first)
    draft.text = "QA message for a still-existing bot"
    store.saveDraft(draft, channel: second.id)
    await store.enqueue(second)
    let queuedBefore = store.state.outbox.count
    _ = try await api.request(
      "/__qa/control", method: "POST", body: .object(["offline": .bool(false)]))
    _ = try await api.request("/api/v0/bots/bot-research", method: "DELETE")
    await store.refresh()
    let delivered = store.messages(second.id).contains { $0.content == draft.text }
    guard queuedBefore == 2, delivered, store.state.outbox.count == 1,
      let missing = store.state.outbox.first, missing.channelId == first.id,
      missing.failure != nil, missing.stagedFiles?.first?.fileName == "queued-proof.txt"
    else { throw APIError("A deleted conversation blocked or lost a queued message.") }
    var existing = Draft()
    existing.text = "Existing destination draft"
    store.saveDraft(existing, channel: second.id)
    store.recoverPending(missing.id, to: second.id)
    let recovered = store.draft(second.id)
    guard store.state.outbox.isEmpty,
      recovered.text
        == "Existing destination draft\n\nQA message for a bot deleted on another device",
      recovered.stagedFiles?.first?.fileName == "queued-proof.txt"
    else { throw APIError("Recovery did not preserve the message, file, and destination draft.") }
    print(
      "PASS: deleted conversation isolated; unrelated send delivered; failed message and file recover into existing draft."
    )
  }
}

#if !canImport(UIKit)
  // The probe never migrates an installed iOS application or registers push notifications.
  enum NativeNotifications {
    static func scope(_ record: SessionRecord) -> String {
      fatalError("Unexpected iOS migration in isolated store audit")
    }
  }
#endif
