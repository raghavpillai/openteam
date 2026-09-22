import Foundation

/// Run only against a disposable loopback fixture using isolated QA persistence.
@main struct LocalResetAudit {
  @MainActor static func main() async throws {
    guard ProcessInfo.processInfo.arguments.contains("--ui-testing") else {
      fatalError("Use --ui-testing to isolate persistence")
    }
    let fixture = try API(server: "http://127.0.0.1:20017")
    _ = try await fixture.request("/__qa/reset", method: "POST")
    let store = AppStore()
    await store.start()
    store.setForeground(false)
    let channel = store.channels.first!
    _ = try await fixture.request("/__qa/control", method: "POST", body: .object(["offline": .bool(true)]))
    await store.refresh()
    var draft = Draft()
    draft.text = "Unsent private text"
    store.saveDraft(draft, channel: channel.id)
    try store.stage(Data("private attachment".utf8), name: "private.txt", mime: "text/plain", channel: channel.id)
    await store.enqueue(channel)
    precondition(store.state.outbox.count == 1)
    draft.text = "Another private draft"
    store.saveDraft(draft, channel: channel.id)
    let began = Date()
    store.beginReauthentication()
    precondition(Date().timeIntervalSince(began) < 2, "Reset must not wait on the network")
    precondition(store.phase == .signedOut && store.api == nil)
    precondition(store.server.isEmpty && store.userName.isEmpty && store.authPath == [.endpoint])
    precondition(store.state.outbox.isEmpty && store.state.drafts.isEmpty && store.channels.isEmpty)
    precondition(store.histories.isEmpty && store.navigation.isEmpty)
    // A disappearing old composer must not write its draft back after the reset.
    store.saveDraft(draft, channel: channel.id)
    precondition(store.state.drafts.isEmpty)
    _ = try await fixture.request("/__qa/control", method: "POST", body: .object(["offline": .bool(false)]))
    store.server = fixture.baseURL.absoluteString
    await store.connect(username: "", password: "")
    precondition(store.phase == .ready && store.state.drafts.isEmpty && store.state.outbox.isEmpty)
    precondition(!store.messages(channel.id).contains { $0.content == "Unsent private text" })
    store.setForeground(false)
    print("PASS: offline reset, queued send and attachment removal, stale-draft rejection, fresh reconnect")
    for server in ["http://100.94.42.50:8787", "https://office-mac-mini.tail658346.ts.net:10000"] {
      let live = try API(server: server, timeout: 12)
      let mode = try await live.validateServer()
      precondition(mode == "required")
      print("PASS: native API live connection and authentication challenge: \(server)")
    }
  }
}
