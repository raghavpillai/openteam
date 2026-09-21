import CryptoKit
import Foundation
import Observation

@MainActor @Observable
final class AppStore {
  enum Phase { case starting, signedOut, ready }
  enum AuthStep: String, Hashable { case endpoint, credentials }
  var phase: Phase = .starting
  var launchComplete = false
  var authPath: [AuthStep] = []
  var authError: String?
  var validatedServer: String?
  private var authGeneration = UUID()
  private var pendingDeepLink: URL?
  var requiresAuthentication: Bool { record?.mode == "required" }
  var server = UserDefaults.standard.string(forKey: "server") ?? ""
  var userName = ""
  var accountDisplayName: String { record?.displayName ?? "OpenTeam owner" }
  var accountServer: String { record?.server ?? server }
  var state = SavedState()
  private var drafts: [String: Draft] = [:]
  private var persistenceTask: Task<Void, Never>?
  private var writer: StateWriter?
  var error: String?
  var online = false
  var connecting = false
  var busy: Set<String> = []
  var navigation: [String] = []
  var focusedRoutine: String?
  var focusedMessage: String?
  var activeChannel: String?
  var histories: [String: History] = [:]
  var historyWindows: [String: HistoryWindow] = [:]
  var sidebar: JSON {
    get {
      state.sidebar
        ?? .object([
          "version": .number(2), "pinnedIds": .array([]), "unreadIds": .array([]),
          "unassignedCollapsed": .bool(false), "sections": .array([]),
          "sectionByChannel": .object([:]),
          "channelOrderByGroup": .object([:]),
        ])
    }
    set {
      guard state.sidebar != newValue else { return }
      state.sidebar = newValue
      persist()
    }
  }
  private(set) var api: API?
  private var disk: DiskStore?
  private var record: SessionRecord?
  private var lifecycle: Task<Void, Never>?
  private var generation = UUID()
  private var sending = false
  private var foreground = true
  private var testing = false
  private let testDirectory: URL = {
    #if targetEnvironment(simulator)
      let args = ProcessInfo.processInfo.arguments
      if args.contains("--ui-testing"), let index = args.firstIndex(of: "--qa-session"),
        args.indices.contains(index + 1), let id = UUID(uuidString: args[index + 1]) {
        return FileManager.default.temporaryDirectory.appendingPathComponent("qa-" + id.uuidString)
      }
    #endif
    return FileManager.default.temporaryDirectory.appendingPathComponent("qa-" + UUID().uuidString)
  }()
  var bots: [Bot] { state.bootstrap?.bots ?? [] }
  var channels: [Channel] { state.bootstrap?.channels ?? [] }
  var pins: [String] { sidebar["pinnedIds"].array.map(\.string) }
  func bot(for channel: Channel) -> Bot? { bots.first { $0.dmChannelId == channel.id } }
  func computerBot(for channel: Channel) -> Bot? {
    ConversationComputer.target(
      channel: self.channel(channel.id) ?? channel, bots: bots, messages: messages(channel.id))
  }
  func channel(_ id: String) -> Channel? { channels.first { $0.id == id } }
  func messages(_ id: String) -> [Message] { state.messages[id] ?? [] }
  func visibleMessages(_ id: String) -> [Message] {
    guard let window = historyWindows[id] else { return messages(id) }
    return messages(id).filter { window.contains($0) }
  }
  func draft(_ id: String) -> Draft { drafts[id] ?? Draft() }
  func isHidden(_ channel: Channel) -> Bool {
    bot(for: channel)?.hiddenFromSidebar ?? channel.hiddenFromSidebar ?? false
  }
  func activeRuns(_ id: String) -> [Run] {
    (state.bootstrap?.activeRuns ?? []).filter { $0.channelId == id && $0.isActive }
  }
  func approvals(_ channel: Channel) -> [Approval] {
    let runIDs = Set(activeRuns(channel.id).map(\.id))
    let pending = (state.bootstrap?.pendingApprovals ?? []).filter {
      runIDs.contains($0.runId) || $0.ownerConversationId == bot(for: channel)?.conversationId
        || $0.ownerConversationId == channel.id
    }
    var result = Dictionary(
      (state.approvals?[channel.id] ?? []).map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
    for approval in pending where result[approval.id] == nil { result[approval.id] = approval }
    return result.values.sorted { $0.id < $1.id }
  }

  func start() async {
    #if DEBUG
      let args = ProcessInfo.processInfo.arguments
      #if targetEnvironment(simulator)
        // SpringBoard cold launches do not preserve XCTest launch arguments.
        // Restore only a one-use, credential-free loopback fixture session.
        let qaSession = UserDefaults.standard.data(forKey: "qa-native-push-cold-session")
        UserDefaults.standard.removeObject(forKey: "qa-native-push-cold-session")
        if !args.contains("--ui-testing"), let qaSession,
          let saved = try? JSONDecoder().decode(SessionRecord.self, from: qaSession),
          saved.token == nil, saved.mode == "disabled",
          ["127.0.0.1", "localhost"].contains(URL(string: saved.server)?.host ?? "")
        {
          testing = true
          do {
            try activate(saved)
            await refresh()
            startEvents()
          } catch {
            phase = .signedOut
            authError = UserFacingError.message(error)
          }
          return
        }
      #endif
      testing = args.contains("--ui-testing")
      #if targetEnvironment(simulator)
        if testing, args.contains("--qa-interrupted-reset") {
          UserDefaults.standard.set(true, forKey: LocalDataReset.pendingKey)
        }
      #endif
      if let index = args.firstIndex(of: "--server"), args.indices.contains(index + 1) {
        server = args[index + 1]
      }
      if let index = args.firstIndex(of: "--appearance"), args.indices.contains(index + 1), testing
      {
        UserDefaults.standard.set(args[index + 1], forKey: "appearance")
      }
      if testing, args.contains("--haptic-audit"), let index = args.firstIndex(of: "--haptics"),
        args.indices.contains(index + 1)
      {
        UserDefaults.standard.set(args[index + 1] == "on", forKey: "haptics")
      }
      if testing {
        phase = .signedOut
        if !args.contains("--show-login"), !server.isEmpty {
          await connect(username: "", password: "")
        }
        if let index = args.firstIndex(of: "--open-channel"), args.indices.contains(index + 1) {
          let channelID = args[index + 1]
          if let draftIndex = args.firstIndex(of: "--visual-draft"),
            args.indices.contains(draftIndex + 1)
          {
            var value = Draft()
            value.text = args[draftIndex + 1]
            saveDraft(value, channel: channelID)
          }
          navigation = [channelID]
        }
        return
      }
    #endif
    do {
      if UserDefaults.standard.bool(forKey: LocalDataReset.pendingKey) {
        beginReauthentication()
        return
      }
      try LegacyInstallation.migrate()
      server = UserDefaults.standard.string(forKey: "server") ?? server
      guard var saved = try SecureSession.read() else {
        phase = .signedOut
        return
      }
      server = saved.server
      do {
        saved = try await saved.refreshIdentity(
          fetch: {
            try await API(server: saved.server, token: saved.token, timeout: 15)
              .request("/api/auth/get-session")
          }, save: { try SecureSession.save($0) })
      } catch {
        handle(APIError("Your session expired. Sign in again.", status: 401))
        return
      }
      try activate(saved)
      await refresh()
      startEvents()
    } catch {
      phase = .signedOut
      authError = UserFacingError.message(error)
    }
  }
  func cancelAuthentication() {
    authGeneration = UUID()
    connecting = false
    clearAuthenticationError()
  }
  func clearAuthenticationError() {
    authError = UserDefaults.standard.bool(forKey: LocalDataReset.pendingKey)
      ? "Couldn't finish clearing local data. Tap Connect to retry, or restart the app." : nil
  }
  func checkServer(feedback: Bool = false) async {
    guard !connecting else { return }
    #if canImport(UIKit)
      if feedback { NativeHaptics.play(.light, source: "auth.submit") }
    #endif
    let epoch = UUID()
    authGeneration = epoch
    connecting = true
    authError = nil
    defer { if authGeneration == epoch { connecting = false } }
    do {
      try finishPendingLocalReset()
      let candidate = try API(server: server, timeout: 15)
      let mode = try await candidate.validateServer()
      guard authGeneration == epoch, !Task.isCancelled else { return }
      server = candidate.baseURL.absoluteString
      validatedServer = server
      if mode == "required" {
        authPath = [.endpoint, .credentials]
      } else {
        try await completeConnection(
          candidate, mode: mode, username: "", password: "", epoch: epoch)
      }
      #if canImport(UIKit)
        if feedback, authGeneration == epoch, !Task.isCancelled {
          NativeHaptics.play(.success, source: "auth.result")
        }
      #endif
    } catch {
      if authGeneration == epoch, !UserFacingError.isCancelled(error) {
        authError = UserFacingError.message(error)
        #if canImport(UIKit)
          if feedback { NativeHaptics.failure(error, source: "auth.result") }
        #endif
      }
    }
  }
  func connect(username: String, password: String, feedback: Bool = false) async {
    guard !connecting else { return }
    #if canImport(UIKit)
      if feedback { NativeHaptics.play(.light, source: "auth.submit") }
    #endif
    connecting = true
    authError = nil
    let epoch = UUID()
    authGeneration = epoch
    defer { if authGeneration == epoch { connecting = false } }
    do {
      try finishPendingLocalReset()
      let candidate = try API(server: server, timeout: 15)
      let mode = try await candidate.validateServer()
      guard authGeneration == epoch, !Task.isCancelled else { return }
      validatedServer = candidate.baseURL.absoluteString
      if mode == "required", username.isEmpty || password.isEmpty {
        authPath = [.endpoint, .credentials]
        throw APIError("Enter your OpenTeam username and password.")
      }
      try await completeConnection(
        candidate, mode: mode, username: username, password: password, epoch: epoch)
      #if canImport(UIKit)
        if feedback, authGeneration == epoch, !Task.isCancelled {
          NativeHaptics.play(.success, source: "auth.result")
        }
      #endif
    } catch {
      if authGeneration == epoch, !UserFacingError.isCancelled(error) {
        authError = UserFacingError.message(error)
        #if canImport(UIKit)
          if feedback { NativeHaptics.failure(error, source: "auth.result") }
        #endif
      }
    }
  }
  private func completeConnection(
    _ candidate: API, mode: String, username: String, password: String, epoch: UUID
  ) async throws {
    let login: (token: String?, userID: String, name: String)
    if mode == "required" {
      guard !username.trimmingCharacters(in: .whitespaces).isEmpty, !password.isEmpty else {
        throw APIError("Enter your OpenTeam username and password.")
      }
      let response = try await candidate.signIn(username: username, password: password)
      guard !response.user["id"].string.isEmpty else {
        throw APIError("The server did not identify your account.")
      }
      login = (
        response.token, response.user["id"].string,
        [
          response.user["name"].string, response.user["username"].string,
          response.user["email"].string,
        ].first { !$0.isEmpty } ?? username
      )
    } else {
      login = (nil, "auth-disabled", "Local owner")
    }
    let next = SessionRecord(
      server: candidate.baseURL.absoluteString, token: login.token, userID: login.userID,
      userName: login.name, mode: mode)
    // Verify a product response before saving or replacing a working account.
    let bootstrap = try await API(server: next.server, token: next.token).get(
      "/api/v0/client-bootstrap", as: Bootstrap.self)
    guard authGeneration == epoch, !Task.isCancelled else { return }
    #if canImport(UIKit)
      if let previous = record,
        previous.server != next.server || previous.userID != next.userID
      {
        do {
          try await NativeNotifications.shared.retire()
          guard authGeneration == epoch, !Task.isCancelled else { return }
        } catch {
          NativeNotifications.shared.bind(previous)
          Task { await NativeNotifications.shared.resume() }
          throw error
        }
      }
    #endif
    try activate(next, persistSession: !testing)
    apply(bootstrap)
    online = true
    persist()
    UserDefaults.standard.set(server, forKey: "server")
    startEvents()
    authError = nil
    authPath = []
    if let url = pendingDeepLink {
      pendingDeepLink = nil
      await deepLink(url)
    }
  }
  private func activate(_ next: SessionRecord, persistSession: Bool = false) throws {
    let nextAPI = try API(server: next.server, token: next.token)
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("OpenTeam", isDirectory: true)
    let scope = SHA256.hash(data: Data((next.server + "\n" + next.userID).utf8)).map {
      String(format: "%02x", $0)
    }.joined()
    let nextDisk = try DiskStore(
      directory: testing
        ? testDirectory
        : base, scope: scope)
    flushPersistence()
    let nextState = try nextDisk.load()
    if persistSession { try SecureSession.save(next) }
    lifecycle?.cancel()
    generation = UUID()
    navigation = []
    activeChannel = nil
    histories = [:]
    historyWindows = [:]
    record = next
    server = next.server
    userName = next.displayName
    api = nextAPI
    disk = nextDisk
    writer = StateWriter(disk: nextDisk)
    state = nextState
    drafts = nextState.drafts
    phase = .ready
    #if canImport(UIKit)
      NativeNotifications.shared.bind(next)
      Task { await NativeNotifications.shared.resume(requestPermission: launchComplete) }
    #endif
  }
  private func apply(_ bootstrap: Bootstrap) {
    state.bootstrap = bootstrap
    for (channel, messages) in Dictionary(grouping: bootstrap.latestMessages, by: \.channelId) {
      merge(messages, channel: channel)
    }
    #if canImport(UIKit)
      NativeNotifications.shared.apply(channels: bootstrap.channels)
    #endif
  }
  private var savedSnapshot: SavedState {
    var snapshot = state
    snapshot.drafts = drafts
    return snapshot
  }
  func persist() {
    guard phase == .ready else { return }
    persistenceTask?.cancel()
    let epoch = generation
    persistenceTask = Task { [weak self] in
      do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
      guard let self, self.phase == .ready, self.generation == epoch, let writer = self.writer else { return }
      writer.save(self.savedSnapshot) { [weak self] result in
        if case .failure(let error) = result {
          Task { @MainActor [weak self] in
            guard let self, self.generation == epoch else { return }
            self.error = "Could not save data on this iPhone: \(error.localizedDescription)"
          }
        }
      }
    }
  }
  func flushPersistence() {
    persistenceTask?.cancel()
    persistenceTask = nil
    guard phase == .ready else { return }
    do { try writer?.saveNow(savedSnapshot) }
    catch { self.error = "Could not save data on this iPhone: \(error.localizedDescription)" }
  }
  private func commit(_ next: SavedState) throws {
    guard let writer else { throw APIError("Connect before saving a message.") }
    persistenceTask?.cancel()
    persistenceTask = nil
    try writer.saveNow(next)
    state = next
    drafts = next.drafts
  }
  private func stopPersistence() {
    #if canImport(UIKit)
      MessageDocuments.clear()
    #endif
    persistenceTask?.cancel()
    persistenceTask = nil
    writer?.drain()
    writer = nil
    drafts = [:]
  }
  func saveDraft(_ value: Draft, channel: String) {
    guard phase == .ready, drafts[channel] != value else { return }
    drafts[channel] = value
    persist()
  }
  func stage(_ data: Data, name: String, mime: String, channel: String) throws {
    guard let disk else { throw APIError("Connect to a server before attaching a file.") }
    var draft = draft(channel)
    guard draft.attachments.count + (draft.stagedFiles?.count ?? 0) < 6 else {
      throw APIError("A message can contain up to six attachments.")
    }
    let file = try disk.stage(data, fileName: name, mimeType: mime)
    draft.stagedFiles = (draft.stagedFiles ?? []) + [file]
    var next = savedSnapshot
    next.drafts[channel] = draft
    do {
      try commit(next)
    } catch {
      try? disk.removeFile(file)
      throw error
    }
  }
  func removeStagedFile(_ file: StagedFile, channel: String) {
    var next = savedSnapshot
    next.drafts[channel]?.stagedFiles?.removeAll { $0.id == file.id }
    do {
      try commit(next)
      try disk?.removeFile(file)
    } catch { self.error = error.localizedDescription }
  }
  func refresh() async {
    guard let api, phase == .ready else { return }
    let epoch = generation
    do {
      let bootstrap = try await api.get("/api/v0/client-bootstrap", as: Bootstrap.self)
      guard epoch == generation, !Task.isCancelled else { return }
      apply(bootstrap)
      online = true
      persist()
      let root = try await api.request("/api/v0/settings")
      guard epoch == generation else { return }
      if root["settings"]["sidebarPreferences"]["version"].int == 2 {
        sidebar = root["settings"]["sidebarPreferences"]
      }
      await flush()
    } catch { if epoch == generation { handle(error) } }
  }
  func setForeground(_ active: Bool) {
    foreground = active
    if active {
      #if canImport(UIKit)
        Task { await NativeNotifications.shared.resume() }
      #endif
      startEvents()
    } else {
      lifecycle?.cancel()
      lifecycle = nil
      flushPersistence()
    }
  }
  private func startEvents() {
    lifecycle?.cancel()
    guard phase == .ready, foreground else { return }
    let epoch = generation
    lifecycle = Task { [weak self] in
      guard let self else { return }
      await refresh()
      if let activeChannel { await loadHistory(activeChannel) }
      var cursor = state.bootstrap?.cursor ?? "0"
      var delay: UInt64 = 1
      while !Task.isCancelled, epoch == generation, phase == .ready, let api {
        do {
          let batch = try await api.get(
            "/api/v0/events/poll", as: EventBatch.self, query: ["after": cursor, "waitMs": "25000"])
          try Task.checkCancellation()
          guard epoch == generation else { return }
          online = true
          delay = 1
          if !batch.events.isEmpty {
            // Reconcile authoritative bounded projections. Advance the cursor only after reconciliation succeeds.
            let bootstrap = try await api.get("/api/v0/client-bootstrap", as: Bootstrap.self)
            try Task.checkCancellation()
            guard epoch == generation else { return }
            apply(bootstrap)
            if let activeChannel {
              try await fetchHistory(activeChannel, before: nil, api: api, epoch: epoch)
            }
            cursor = bootstrap.cursor
            persist()
          }
          await flush()
        } catch {
          if Task.isCancelled || epoch != generation { return }
          handle(error, quiet: true)
          try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
          delay = min(delay * 2, 30)
        }
      }
    }
  }
  func loadHistory(_ id: String, older: Bool = false) async {
    guard let api, !busy.contains("history-" + id) else { return }
    let epoch = generation
    busy.insert("history-" + id)
    defer { busy.remove("history-" + id) }
    do {
      try await fetchHistory(
        id, before: older ? histories[id]?.beforeSequence : nil, api: api, epoch: epoch)
    } catch {
      if epoch == generation {
        let hasCachedContent = !messages(id).isEmpty || state.outbox.contains { $0.channelId == id }
        let connectionFailure = error is URLError || ((error as? APIError)?.status ?? 0) >= 500
        // Opening a cached conversation is usable offline. Background refresh
        // failures update connection state without interrupting a queued reply.
        // Explicit pagination and non-transient failures still surface an error.
        handle(error, quiet: !older && hasCachedContent && connectionFailure)
      }
    }
  }
  private func fetchHistory(_ id: String, before: String?, api: API, epoch: UUID) async throws {
    var query = ["limit": "60"]
    if let before { query["before"] = before }
    let page = try await api.get(
      "/api/v0/channels/\(API.segment(id))/history", as: History.self, query: query)
    guard epoch == generation, !Task.isCancelled else { return }
    if before != nil {
      state.messages[id] = MessageMerge.merge(messages(id), page.threadContext + page.messages)
      historyWindows[id]?.extend(page.messages, earlier: true, hasMore: page.hasMore)
      histories[id] = page
    } else if histories[id] == nil {
      install(page)
    } else {
      // A search result is a continuous older window, not an invitation to append
      // a disconnected latest page. Polling may still update rows in that window.
      merge(page.threadContext + page.messages, channel: id)
    }
    let snapshot = try await api.get(
      "/api/v0/channels/\(API.segment(id))/client-state", as: ChannelState.self)
    guard epoch == generation, !Task.isCancelled else { return }
    if state.approvals == nil { state.approvals = [:] }
    state.approvals?[id] = snapshot.approvals
    persist()
  }
  func merge(_ incoming: [Message], channel: String) {
    let existing = messages(channel)
    let ids = Set(existing.map(\.id))
    let visible = incoming.filter {
      ids.contains($0.id) || historyWindows[channel]?.contains($0) != false
    }
    state.messages[channel] = MessageMerge.merge(existing, visible)
    let accepted = Set(incoming.compactMap(\.clientId))
    state.outbox.removeAll { accepted.contains($0.id) }
  }
  private func install(_ page: History) {
    histories[page.channelId] = page
    historyWindows[page.channelId] = HistoryWindow(
      messages: page.messages, hasEarlier: page.hasMore, hasLater: false)
    state.messages[page.channelId] = MessageMerge.merge(page.threadContext, page.messages)
  }
  @discardableResult
  func loadContext(_ channelID: String, messageID: String) async -> Bool {
    guard let api else { return false }
    let epoch = generation
    do {
      let page = try await api.get(
        "/api/v0/channel-messages/\(API.segment(messageID))/context", as: MessageContext.self)
      guard epoch == generation else { return false }
      guard page.channelId == channelID else {
        throw APIError("This message belongs to another conversation.")
      }
      state.messages[channelID] = MessageMerge.merge(page.threadContext, page.messages)
      historyWindows[channelID] = HistoryWindow(
        messages: page.messages, hasEarlier: page.hasMoreBefore, hasLater: page.hasMoreAfter)
      histories[channelID] = History(
        channelId: channelID, messages: [], threadContext: [], beforeSequence: page.beforeSequence,
        hasMore: page.hasMoreBefore, revision: page.revision)
      persist()
      return true
    } catch {
      if epoch == generation { handle(error) }
      return false
    }
  }
  func loadLater(_ channelID: String) async {
    let key = "later-" + channelID
    guard let api, !busy.contains(key), historyWindows[channelID]?.hasLater == true,
      let last = visibleMessages(channelID).last else { return }
    busy.insert(key)
    defer { busy.remove(key) }
    let epoch = generation
    do {
      let page = try await api.get(
        "/api/v0/channel-messages/\(API.segment(last.id))/context", as: MessageContext.self,
        query: ["direction": "after", "limit": "60"])
      guard epoch == generation else { return }
      guard page.channelId == channelID else { throw APIError("The conversation changed.") }
      state.messages[channelID] = MessageMerge.merge(messages(channelID), page.threadContext + page.messages)
      historyWindows[channelID]?.extend(page.messages, earlier: false, hasMore: page.hasMoreAfter)
      persist()
    } catch { if epoch == generation { handle(error) } }
  }
  @discardableResult
  func loadLatest(_ channelID: String) async -> Bool {
    guard let api else { return false }
    let epoch = generation
    do {
      let page = try await api.get(
        "/api/v0/channels/\(API.segment(channelID))/history", as: History.self, query: ["limit": "60"])
      guard epoch == generation else { return false }
      install(page)
      persist()
      return true
    } catch {
      if epoch == generation { handle(error) }
      return false
    }
  }
  func markRead(_ id: String, through sequence: String? = nil) async {
    guard foreground, activeChannel == id, let api,
      channel(id) != nil
    else { return }
    let through =
      sequence ?? messages(id).last(where: { !$0.metadata["branched"].bool })?.sequence ?? "0"
    let notificationCursor =
      NotificationReads.sequence(channel(id)?.notificationState?["notificationCursor"].string ?? "")
      ?? "0"
    let previousActivity =
      NotificationReads.sequence(
        channel(id)?.notificationState?["lastReadNotificationSequence"].string ?? "") ?? "0"
    let previous = channel(id)?.notificationState?["lastReadSequence"].string ?? ""
    if !previous.isEmpty, !MessageMerge.less(previous, through),
      !MessageMerge.less(previousActivity, notificationCursor), channel(id)?.unreadCount == 0,
      !sidebar["unreadIds"].array.contains(.string(id))
    {
      return
    }
    let epoch = generation
    do {
      let value = try await api.request(
        "/api/v0/channels/\(API.segment(id))/read", method: "POST",
        body: .object([
          "throughSequence": .string(through),
          "throughNotificationSequence": .string(notificationCursor),
        ]))
      guard epoch == generation,
        let index = state.bootstrap?.channels.firstIndex(where: { $0.id == id })
      else { return }
      state.bootstrap?.channels[index].unreadCount = value["unreadCount"].int
      var notification = state.bootstrap?.channels[index].notificationState ?? .object([:])
      notification["lastReadSequence"] =
        value["lastReadSequence"] == .null ? .string(through) : value["lastReadSequence"]
      notification["lastReadNotificationSequence"] =
        value["lastReadNotificationSequence"] == .null
        ? .string(notificationCursor) : value["lastReadNotificationSequence"]
      state.bootstrap?.channels[index].notificationState = notification
      #if canImport(UIKit)
        NativeNotifications.shared.apply(channels: channels)
      #endif
      if sidebar["unreadIds"].array.contains(.string(id)) {
        var next = sidebar
        next["unreadIds"] = .array(next["unreadIds"].array.filter { $0 != .string(id) })
        if let saved = try? await api.request(
          "/api/v0/settings/sidebar", method: "PATCH", body: next), epoch == generation
        {
          sidebar = saved
        }
      }
      persist()
    } catch { if epoch == generation { handle(error, quiet: true) } }
  }
  func enqueue(_ channel: Channel, draftKey: String? = nil, threadRootID: String? = nil,
    replyRootID: String? = nil) async {
    let key = draftKey ?? channel.id
    let current = draft(key)
    guard
      !current.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || !current.attachments.isEmpty || !(current.stagedFiles ?? []).isEmpty
    else { return }
    if threadRootID == nil, replyRootID == nil,
      await answerWidgetFromComposer(channel, draftKey: key) { return }
    #if canImport(UIKit)
      NativeHaptics.play(.light, source: "message.send")
    #endif
    let input = SendInput(
      content: current.text, attachments: current.attachments,
      replyToMessageId: current.replyTo ?? threadRootID ?? replyRootID,
      isFork: (current.isFork || threadRootID != nil) ? true : nil)
    var next = savedSnapshot
    next.outbox.append(
      PendingSend(
        channelId: channel.id, input: input, stagedFiles: current.stagedFiles ?? [], draftKey: key))
    var emptyDraft = Draft()
    emptyDraft.replyTo = threadRootID ?? replyRootID
    emptyDraft.isFork = threadRootID != nil
    next.drafts[key] = emptyDraft
    do {
      try commit(next)
      await flush()
    } catch {
      #if canImport(UIKit)
        NativeHaptics.failure(error, source: "message.send")
      #endif
      self.error =
        "Your message was not queued because it could not be saved. \(error.localizedDescription)"
    }
  }
  /// Forward independently of the recipient's draft, using the durable send queue.
  func forwardAttachment(_ asset: Asset, to channel: Channel) async throws {
    guard phase == .ready, let disk else {
      throw APIError("Connect to your server before forwarding.")
    }
    var next = savedSnapshot
    next.outbox.append(
      PendingSend(channelId: channel.id, input: SendInput(content: "", attachments: [asset])))
    try commit(next)
    #if canImport(UIKit)
      NativeHaptics.play(.light, source: "attachment.forward-send")
    #endif
    await flush()
  }
  func retry(_ id: String) async {
    if let i = state.outbox.firstIndex(where: { $0.id == id }) {
      #if canImport(UIKit)
        NativeHaptics.play(.light, source: "message.retry")
      #endif
      state.outbox[i].failure = nil
      persist()
    }
    await flush()
  }
  func discard(_ id: String) {
    let files = state.outbox.first(where: { $0.id == id })?.stagedFiles ?? []
    var next = savedSnapshot
    next.outbox.removeAll { $0.id == id }
    do {
      try commit(next)
      for file in files { try? disk?.removeFile(file) }
    } catch {
      #if canImport(UIKit)
        NativeHaptics.failure(error, source: "message.discard")
      #endif
      handle(error)
    }
  }
  /// Recover into an existing draft without sending or losing that draft's content.
  @discardableResult func recoverPending(_ id: String, to channelID: String) -> Bool {
    guard channel(channelID) != nil,
      let pending = state.outbox.first(where: { $0.id == id }),
      channel(pending.channelId) == nil, let disk
    else { return false }
    var next = savedSnapshot
    var draft = next.drafts[channelID] ?? Draft()
    guard
      draft.attachments.count + (draft.stagedFiles?.count ?? 0) + pending.input.attachments.count
        + (pending.stagedFiles?.count ?? 0) <= 6
    else {
      error =
        "This draft would have more than 6 attachments. Choose another conversation or remove an attachment from its draft first."
      return false
    }
    if !pending.input.content.isEmpty {
      draft.text = [draft.text, pending.input.content].filter { !$0.isEmpty }.joined(
        separator: "\n\n")
    }
    draft.attachments += pending.input.attachments
    draft.stagedFiles = (draft.stagedFiles ?? []) + (pending.stagedFiles ?? [])
    next.drafts[channelID] = draft
    next.outbox.removeAll { $0.id == id }
    do {
      try commit(next)
      return true
    } catch {
      handle(error)
      return false
    }
  }
  func flush() async {
    guard !sending, let api, online else { return }
    sending = true
    let epoch = generation
    defer { if epoch == generation { sending = false } }
    // One request per nonce at a time; after a timeout, reconcile before resubmitting that same nonce.
    for pending in state.outbox where pending.failure == nil {
      guard epoch == generation, !Task.isCancelled else { return }
      guard let channel = channel(pending.channelId) else {
        if let index = state.outbox.firstIndex(where: { $0.id == pending.id }) {
          state.outbox[index].failure =
            "This conversation is no longer available. Your unsent message remains saved on this iPhone."
          persist()
        }
        continue
      }
      do {
        let delivery = try await api.get(
          "/api/v0/channels/\(API.segment(channel.id))/message-deliveries/\(API.segment(pending.id))",
          as: DeliveryStatus.self)
        guard epoch == generation else { return }
        if let message = delivery.message {
          merge([message], channel: channel.id)
          persist()
          continue
        }
        if delivery.status == "pending" || delivery.status == "unknown_durability" { continue }
        if delivery.status == "rejected" {
          throw APIError(delivery.messageText ?? "The server rejected this message.", status: 422)
        }
        guard delivery.status == "not_found" else { continue }
        for file in pending.stagedFiles ?? [] {
          guard let disk else { throw APIError("The saved attachment is unavailable.") }
          let bytes = try Data(contentsOf: disk.fileURL(file))
          let (data, _) = try await api.raw(
            "/api/v0/assets", method: "POST", data: bytes, contentType: file.mimeType,
            headers: [
              "x-file-name": file.fileName.addingPercentEncoding(
                withAllowedCharacters: .alphanumerics) ?? "File"
            ])
          guard epoch == generation,
            let index = state.outbox.firstIndex(where: { $0.id == pending.id })
          else { return }
          let asset = try JSONDecoder().decode(Asset.self, from: data)
          var next = savedSnapshot
          next.outbox[index].input.attachments.append(asset)
          next.outbox[index].stagedFiles?.removeAll { $0.id == file.id }
          try commit(next)
          try? disk.removeFile(file)
        }
        guard let committed = state.outbox.first(where: { $0.id == pending.id }) else { continue }
        let message = try await api.send(
          channel: channel, bot: bot(for: channel), input: committed.input)
        guard epoch == generation else { return }
        merge([message], channel: channel.id)
        persist()
      } catch {
        guard epoch == generation else { return }
        if let e = error as? APIError, (400..<500).contains(e.status), e.status != 401,
          e.status != 408, e.status != 429
        {
          if let i = state.outbox.firstIndex(where: { $0.id == pending.id }) {
            #if canImport(UIKit)
              if state.outbox[i].failure == nil {
                NativeHaptics.play(.error, source: "message.rejected")
              }
            #endif
            state.outbox[i].failure = e.message
            persist()
          }
        } else {
          handle(error, quiet: true)
          return
        }
      }
    }
  }
  @discardableResult
  func mutate(
    _ path: String, method: String = "POST", body: JSON? = nil,
    successFeedback: HapticEffect? = nil, feedbackSource: String = "mutation"
  ) async -> JSON? {
    guard let api, !busy.contains(path) else { return nil }
    let epoch = generation
    busy.insert(path)
    defer { busy.remove(path) }
    do {
      let result = try await api.request(path, method: method, body: body)
      guard epoch == generation else { return nil }
      if let message = try? result["message"].decode(Message.self) {
        merge([message], channel: message.channelId)
      }
      await refresh()
      guard epoch == generation else { return nil }
      #if canImport(UIKit)
        if let successFeedback { NativeHaptics.play(successFeedback, source: feedbackSource) }
      #endif
      return result
    } catch {
      if epoch == generation {
        handle(error)
        #if canImport(UIKit)
          NativeHaptics.failure(error, source: feedbackSource)
        #endif
      }
      return nil
    }
  }
  /// Reads and native form writes share account-generation and session-expiry handling.
  func request(
    _ path: String, method: String = "GET", body: JSON? = nil, query: [String: String] = [:]
  ) async throws -> JSON {
    guard let api else { throw APIError("Sign in to continue.", status: 401) }
    let epoch = generation
    do {
      let result = try await api.request(path, method: method, body: body, query: query)
      guard epoch == generation, !Task.isCancelled else { throw CancellationError() }
      return result
    } catch {
      guard epoch == generation else { throw CancellationError() }
      if (error as? APIError)?.unauthorized == true { handle(error) }
      throw error
    }
  }
  func fetch<T: Decodable>(_ path: String, as type: T.Type, query: [String: String] = [:])
    async throws -> T
  {
    try await request(path, query: query).decode(type)
  }
  func togglePin(_ id: String) async {
    var next = sidebar
    var values = pins
    if values.contains(id) { values.removeAll { $0 == id } } else { values.append(id) }
    next["pinnedIds"] = .array(values.map(JSON.string))
    if let result = await mutate("/api/v0/settings/sidebar", method: "PATCH", body: next) {
      sidebar = result
    }
  }
  func hide(_ channel: Channel, hidden: Bool) async {
    if let bot = bot(for: channel) {
      await mutate(
        "/api/v0/bots/\(API.segment(bot.id))", method: "PATCH",
        body: .object(["hiddenFromSidebar": .bool(hidden)]))
    } else {
      await mutate(
        "/api/v0/channels/\(API.segment(channel.id))/hidden", method: "PATCH",
        body: .object(["hidden": .bool(hidden), "clientId": .string(UUID().uuidString)]))
    }
  }
  func open(_ channelID: String, messageID: String? = nil) async {
    let epoch = generation
    if let messageID {
      guard await loadContext(channelID, messageID: messageID) else { return }
      guard epoch == generation else { return }
    }
    focusedMessage = messageID
    navigation = [channelID]
  }
  func deepLink(_ url: URL) async {
    guard ["openteam", "openteam-swift"].contains(url.scheme ?? "") else { return }
    guard phase == .ready else {
      pendingDeepLink = url
      return
    }
    let parts = url.pathComponents.filter { $0 != "/" }
    if url.host == "chat", let id = parts.first {
      let message = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first {
        $0.name == "messageId"
      }?.value
      await open(id, messageID: message)
    }
  }
  func signOut() async {
    guard let api, !busy.contains("sign-out") else { return }
    busy.insert("sign-out")
    defer { busy.remove("sign-out") }
    do {
      #if canImport(UIKit)
        try await NativeNotifications.shared.retire()
      #endif
      if api.token != nil {
        do { try await api.signOut() } catch let failure
          as APIError where [401, 403].contains(failure.status)
        {
          // Already expired.
        }
      }
      if !testing { try SecureSession.clear() }
      #if canImport(UIKit)
        NativeNotifications.shared.reset()
      #endif
      lifecycle?.cancel()
      generation = UUID()
      stopPersistence()
      var cleanupFailure: String?
      do { try disk?.clear() } catch {
        cleanupFailure =
          "You are signed out, but some cached files could not be removed. Restart the app and try again."
      }
      state = SavedState()
      record = nil
      self.api = nil
      disk = nil
      phase = .signedOut
      navigation = []
      activeChannel = nil
      online = false
      authPath = []
      authError = cleanupFailure
      validatedServer = nil
    } catch {
      self.error = UserFacingError.message(error)
      #if canImport(UIKit)
        if let record {
          NativeNotifications.shared.bind(record)
          await NativeNotifications.shared.resume()
        }
      #endif
    }
  }
  func beginReauthentication() {
    let defaults = UserDefaults.standard
    defaults.set(true, forKey: LocalDataReset.pendingKey)
    lifecycle?.cancel()
    lifecycle = nil
    generation = UUID()
    cancelAuthentication()
    #if canImport(UIKit)
      NativeNotifications.shared.forgetLocally()
    #endif
    stopPersistence()
    phase = .signedOut
    record = nil
    api = nil
    disk = nil
    state = SavedState()
    histories = [:]
    historyWindows = [:]
    navigation = []
    activeChannel = nil
    focusedMessage = nil
    focusedRoutine = nil
    pendingDeepLink = nil
    busy = []
    sending = false
    online = false
    server = ""
    userName = ""
    validatedServer = nil
    error = nil
    authPath = [.endpoint]
    do {
      try finishPendingLocalReset()
      authError = nil
    } catch {
      // A failed wipe never restores the old session, including after a relaunch.
      authError = UserFacingError.message(error)
    }
  }
  private func finishPendingLocalReset() throws {
    let defaults = UserDefaults.standard
    guard defaults.bool(forKey: LocalDataReset.pendingKey) else { return }
    do {
      if !testing {
        try SecureSession.clear()
        try LegacyInstallation.clear()
      }
      var directories = [testDirectory]
      #if canImport(UIKit)
        if !testing {
          // Clear all accounts, including the previous RN app's sandbox data.
          directories = [.applicationSupportDirectory, .cachesDirectory, .documentDirectory]
            .flatMap { FileManager.default.urls(for: $0, in: .userDomainMask) }
          directories.append(FileManager.default.temporaryDirectory)
        }
      #endif
      try LocalDataReset.erase(directories: directories)
      URLCache.shared.removeAllCachedResponses()
      HTTPCookieStorage.shared.cookies?.forEach { HTTPCookieStorage.shared.deleteCookie($0) }
      if let domain = Bundle.main.bundleIdentifier {
        defaults.removePersistentDomain(forName: domain)
      }
      defaults.removeObject(forKey: LocalDataReset.pendingKey)
    } catch {
      // Keep the marker until every step succeeds; a new connection must not
      // reuse any account's data after a partially completed Re-auth.
      throw APIError("Couldn't finish clearing local data. Tap Connect to retry, or restart the app.")
    }
  }
  func handle(_ error: Error, quiet: Bool = false) {
    if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
    if let e = error as? APIError, e.unauthorized {
      #if canImport(UIKit)
        NativeNotifications.shared.reset()
      #endif
      lifecycle?.cancel()
      generation = UUID()
      flushPersistence()
      stopPersistence()
      api = nil
      state = SavedState()
      disk = nil
      phase = .signedOut
      navigation = []
      try? SecureSession.clear()
      validatedServer = server
      authPath = [.endpoint, .credentials]
      authError = "Your session expired. Sign in again. Your drafts are saved on this iPhone."
      self.error = nil
    } else {
      if !(error is APIError) || ((error as? APIError)?.status ?? 0) >= 500 { online = false }
      if !quiet { self.error = UserFacingError.message(error) }
    }
  }
}
