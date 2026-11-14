import AppIntents
import CryptoKit
import Foundation
import Observation

@MainActor @Observable
final class AppStore {
  enum Phase { case starting, signedOut, ready }
  enum AuthStep: String, Hashable { case endpoint, credentials }
  var phase: Phase = .starting
  private(set) var systemScope: String?
  private(set) var systemDiscoveryEnabled = false
  var systemDraft: SystemMessageDraft?
  let botVoiceLaunch = BotVoiceLaunch()
  private var pendingSystemItem: (id: String, draft: String?, attachments: [Asset], record: Bool, createdAt: Date, requestID: UUID)?
  private var systemOpenGeneration = UUID()
  private var systemVoiceRequestID: UUID?
  private var navigationGeneration = UUID()
  var launchComplete = false
  var authPath: [AuthStep] = []
  var authError: String?
  var validatedServer: String?
  /// "✓ Found OpenTeam {version}" on the server screen, shown before it moves on.
  struct FoundServer: Equatable { var version: String? }
  private(set) var foundServer: FoundServer?
  private var authGeneration = UUID()
  private var pendingDeepLink: URL?
  var requiresAuthentication: Bool { record?.mode == "required" }
  var server = UserDefaults.standard.string(forKey: "server") ?? ""
  var userName = ""
  var accountDisplayName: String { record?.displayName ?? "OpenTeam owner" }
  var accountServer: String { record?.server ?? server }
  var state = SavedState()
  private(set) var sidebarPluginsVerified = false
  @ObservationIgnored private var sidebarPluginsRefresh: (id: UUID, epoch: UUID, task: Task<Void, Never>)?
  private var drafts: [String: Draft] = [:]
  private var persistenceTask: Task<Void, Never>?
  private var writer: StateWriter?
  var error: String?
  let reactionMutations = ReactionMutations()
  var online = false
  private(set) var connectionUnavailable = false
  private var connectionCheck: Task<Void, Never>?
  private var connectionCheckID: UUID?
  var checkingConnection: Bool { connectionCheckID != nil }
  private var stateSyncs: Set<UUID> = []
  private var awaitingInitialSync = false
  private var syncUnavailable = false
  var syncingState: Bool { (awaitingInitialSync || !stateSyncs.isEmpty) && !syncUnavailable }
  /// Saved state may lack what happened while the app was in the background:
  /// it is not active yet, or its first sync since becoming active is running.
  var catchingUp: Bool {
    !foreground
      || ((awaitingInitialSync || catchUpSync.map { stateSyncs.contains($0) } == true)
        && !syncUnavailable)
  }
  private var catchUpSync: UUID?
  var connecting = false
  var busy: Set<String> = []
  var navigation: [String] = [] {
    didSet {
      navigationGeneration = UUID()
      openingNotification = nil
      botVoiceLaunch.cancelPending(unless: navigation.last)
    }
  }
  var focusedRoutine: String?
  var focusedMessage: String?
  var focusedNotification: String?
  private(set) var openingNotification: UUID?
  var activeChannel: String?
  var histories: [String: History] = [:]
  private(set) var historyLoadFailures: Set<String> = []
  var historyWindows: [String: HistoryWindow] = [:]
  private var historyOpenings: [String: UUID] = [:]
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
  private(set) var api: API? {
    didSet { PlaceImages.select(api?.resourceGeneration) }
  }
  private var disk: DiskStore?
  private var record: SessionRecord?
  private var lifecycle: Task<Void, Never>?
  private var backgroundHistories: Task<Void, Never>?
  private var backgroundHistoryQueue: [String] = []
  /// Newest message sequence each chat's notifications announced. A push can
  /// arrive, or be tapped, before the next bootstrap knows about its message.
  private var notifiedLatest: [String: String] = [:]
  private var unreadIntents: [String: UUID] = [:]
  @ObservationIgnored private var sidebarWrite: (id: UUID, task: Task<JSON?, Never>)?
  private var needsIdentityRefresh = false
  @ObservationIgnored private var questionReceiptCaches: [String: QuestionReceiptCache] = [:]
  @ObservationIgnored private var questionReceiptOrder: [String] = []
  private var generation = UUID() {
    didSet { questionReceiptCaches.removeAll(); questionReceiptOrder.removeAll() }
  }
  private var sending = false
  private var flushRequested = false
  private(set) var activeSendID: String?
  private(set) var checkingSendID: String?
  /// Presentation-only counts; polling a still-processing send is not a failure.
  private(set) var sendRetryCounts: [String: Int] = [:]
  private var requestedSendIDs: Set<String> = []
  var sendStallTimeout: Duration = .seconds(10)
  var sendOverallTimeout: Duration = .seconds(120)
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
  /// First-run setup: undecided until the first fresh bootstrap after connecting.
  enum OnboardingState { case undecided, showing, hidden }
  private(set) var onboarding: OnboardingState = .hidden
  /// The first bot's chat, just created by onboarding. Home shows its row arriving,
  /// then zooms into it; it clears once the greeting has arrived (W8).
  private(set) var landing: String?
  var runtime: RuntimeStatus { RuntimeStatus(state.bootstrap?.runtime ?? .null) }
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
  func questionMessages(_ channelID: String) -> [Message] {
    let latest = state.bootstrap?.latestMessages.filter { $0.channelId == channelID } ?? []
    return QuestionLifecycle.project(questionAwareMerge(messages(channelID), latest, channel: channelID),
      pending: state.outbox.filter { $0.channelId == channelID })
  }
  private func questionAwareMerge(_ existing: [Message], _ incoming: [Message], channel: String,
    observed: [Message] = []) -> [Message] {
    questionReceiptOrder = [channel] + questionReceiptOrder.filter { $0 != channel }
    questionReceiptOrder = Array(questionReceiptOrder.prefix(4))
    questionReceiptCaches = questionReceiptCaches.filter { questionReceiptOrder.contains($0.key) }
    var receipts = questionReceiptCaches[channel] ?? QuestionReceiptCache()
    let result = receipts.merge(existing, incoming, remembering: messages(channel) + observed)
    questionReceiptCaches[channel] = receipts
    return result
  }
  /// The channel's newest known message, for previews. Bootstrap can know a
  /// newer one than a loaded transcript, which receives it with its next page.
  func latestMessage(_ id: String) -> Message? {
    let loaded = messages(id).last
    guard let latest = state.bootstrap?.latestMessages.last(where: { $0.channelId == id }) else {
      return loaded
    }
    guard let loaded else { return latest }
    return MessageMerge.less(loaded.sequence, latest.sequence) ? latest : loaded
  }
  func hasCachedHistory(_ id: String) -> Bool {
    histories[id] != nil || state.loadedHistoryChannels?.contains(id) == true
  }
  /// A saved transcript that lacks the newest message bootstrap or a push announced.
  func transcriptBehind(_ id: String) -> Bool {
    guard hasCachedHistory(id), historyWindows[id]?.hasLater != true else { return false }
    if state.incompleteHistoryChannels?.contains(id) == true { return true }
    let bootstrap = state.bootstrap?.latestMessages.last(where: { $0.channelId == id })?.sequence
    let known = [bootstrap, notifiedLatest[id]].compactMap { $0 }
      .max { MessageMerge.less($0, $1) }
    guard let known else { return false }
    guard let last = messages(id).last?.sequence else { return true }
    return MessageMerge.less(last, known)
  }
  func noteNotified(_ id: String, sequence: String?) {
    guard let sequence, !sequence.isEmpty else { return }
    if let known = notifiedLatest[id], !MessageMerge.less(known, sequence) { return }
    notifiedLatest[id] = sequence
  }
  /// A notification for a chat that is not open, possibly while the app is in
  /// the background: read its newest page now, so opening it from the
  /// notification shows the reply instead of waiting for it.
  func readNotifiedChat(_ id: String, sequence: String?) async {
    noteNotified(id, sequence: sequence)
    guard phase == .ready, let api, id != activeChannel, !busy.contains("history-" + id),
      channel(id) != nil, !hasCachedHistory(id) || transcriptBehind(id)
    else { return }
    let epoch = generation
    busy.insert("history-" + id)
    defer { busy.remove("history-" + id) }
    try? await fetchHistory(id, before: nil, api: api, epoch: epoch)
    // A background push may be followed by suspension before the debounced save.
    if epoch == generation { flushPersistence() }
  }
  func visibleMessages(_ id: String) -> [Message] {
    guard let window = historyWindows[id] else { return messages(id) }
    return messages(id).filter { window.contains($0) }
  }
  func draft(_ id: String) -> Draft { drafts[id] ?? Draft() }
  func activeRuns(_ id: String) -> [Run] {
    (state.bootstrap?.activeRuns ?? []).filter { $0.channelId == id && $0.isActive }
  }
  func start() async {
    SystemDiscovery.shared.clear()
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
            await routePendingDeepLink()
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
          // XCTest's launch transport can truncate literal newline arguments.
          if let draftIndex = args.firstIndex(of: "--visual-draft-base64"),
            args.indices.contains(draftIndex + 1),
            let data = Data(base64Encoded: args[draftIndex + 1]),
            let text = String(data: data, encoding: .utf8)
          {
            var value = Draft()
            value.text = text
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
      server = UserDefaults.standard.string(forKey: "server") ?? server
      guard let saved = try SecureSession.read() else {
        phase = .signedOut
        return
      }
      // Restore the established account and its disk cache before doing any
      // networking. Slow identity/bootstrap/settings requests and outbox retries
      // must not trap the user behind the launch robot or hide Re-auth.
      try activate(saved)
      needsIdentityRefresh = true
      startEvents()
      await routePendingDeepLink()
    } catch {
      phase = .signedOut
      authError = UserFacingError.message(error)
    }
  }
  func cancelAuthentication() {
    authGeneration = UUID()
    connecting = false
    foundServer = nil
    clearAuthenticationError()
  }
  /// The username that last signed in to `server` on this iPhone, to prefill sign-in.
  func lastUsername(for server: String) -> String {
    testing ? "" : UserDefaults.standard.string(forKey: "last-username:" + server) ?? ""
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
    foundServer = nil
    defer {
      if authGeneration == epoch {
        connecting = false
        foundServer = nil
      }
    }
    do {
      try finishPendingLocalReset()
      let candidate = try API(server: server, timeout: 15)
      let mode = try await candidate.validateServer()
      guard authGeneration == epoch, !Task.isCancelled else { return }
      // Show what was found for a moment, then move on. The version is a nicety: one
      // that doesn't arrive in time doesn't hold up connecting.
      let version = try? await candidate.request("/api/system/version", timeout: 4)
      guard authGeneration == epoch, !Task.isCancelled else { return }
      foundServer = FoundServer(version: version?["releaseVersion"].string)
      #if canImport(UIKit)
        if feedback { NativeHaptics.play(.success, source: "auth.result") }
      #endif
      try? await Task.sleep(for: .milliseconds(800))
      guard authGeneration == epoch, !Task.isCancelled else { return }
      server = candidate.baseURL.absoluteString
      validatedServer = server
      if mode == "required" {
        authPath = [.endpoint, .credentials]
      } else {
        try await completeConnection(
          candidate, mode: mode, username: "", password: "", epoch: epoch)
      }
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
    if mode == "required", !testing {
      UserDefaults.standard.set(
        username.trimmingCharacters(in: .whitespacesAndNewlines),
        forKey: "last-username:" + next.server)
    }
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
    // The notification prompt waits until first-run setup is finished.
    try activate(next, persistSession: !testing, requestPushPermission: false)
    apply(bootstrap)
    #if canImport(UIKit)
      if launchComplete, onboarding != .showing {
        Task { await NativeNotifications.shared.resume(requestPermission: true) }
      }
    #endif
    online = true
    persist()
    UserDefaults.standard.set(server, forKey: "server")
    startEvents()
    authError = nil
    authPath = []
    await routePendingDeepLink()
  }
  private func activate(
    _ next: SessionRecord, persistSession: Bool = false, requestPushPermission: Bool = true
  ) throws {
    let epoch = UUID()
    let nextAPI = try API(server: next.server, token: next.token, onReachable: { [weak self] in
      await self?.recordReachable(epoch: epoch)
    })
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
    stopBackgroundHistories()
    notifiedLatest = [:]
    unreadIntents = [:]
    focusedNotification = nil
    openingNotification = nil
    needsIdentityRefresh = false
    stateSyncs.removeAll()
    awaitingInitialSync = !launchComplete
    syncUnavailable = false
    cancelConnectionCheck()
    connectionUnavailable = false
    generation = epoch
    reactionMutations.cancelAll()
    activeSendID = nil
    checkingSendID = nil
    sending = false
    flushRequested = false
    requestedSendIDs.removeAll()
    navigation = []
    landing = nil
    activeChannel = nil
    histories = [:]
    historyLoadFailures.removeAll()
    historyWindows = [:]
    historyOpenings = [:]
    if let systemScope, systemScope != scope {
      systemDraft = nil
      pendingSystemItem = nil
      botVoiceLaunch.reset()
      SystemDiscovery.shared.clear(removeTransfers: true)
    }
    record = next
    systemScope = scope
    systemDiscoveryEnabled = !testing && SystemDiscovery.enabled(scope: scope)
    SystemDiscovery.shared.clear()
    server = next.server
    userName = next.displayName
    api = nextAPI
    disk = nextDisk
    writer = StateWriter(disk: nextDisk)
    state = nextState
    sidebarPluginsVerified = false
    drafts = nextState.drafts
    onboarding =
      UserDefaults.standard.bool(forKey: OnboardingDecision.key(server: next.server))
        && !onboardingForcedForQA ? .hidden : .undecided
    phase = .ready
    if systemDiscoveryEnabled { SystemDiscovery.shared.update(session: next, state: nextState) }
    if let pending = pendingSystemItem {
      pendingSystemItem = nil
      if pending.record, pending.requestID == systemOpenGeneration {
        systemVoiceRequestID = pending.requestID
      }
      Task {
        do {
          guard pending.requestID == systemOpenGeneration else { return }
          guard !pending.record || Date.now.timeIntervalSince(pending.createdAt) < 30 else {
            throw APIError("Run the voice-note shortcut again to start recording.")
          }
          try await openSystemItem(pending.id, draft: pending.draft,
            attachments: pending.attachments, recordVoiceNote: pending.record)
        } catch {
          if !UserFacingError.isCancelled(error) { self.error = UserFacingError.message(error) }
        }
      }
    }
    #if canImport(UIKit)
      NativeNotifications.shared.bind(next)
      if launchComplete, requestPushPermission {
        Task { await NativeNotifications.shared.resume(requestPermission: true) }
      }
    #endif
  }
  private func apply(_ bootstrap: Bootstrap) {
    let previous = state.bootstrap
    let directoryChanged = previous?.bots != bootstrap.bots
      || previous?.channels.map { "\($0.id):\($0.name):\($0.hiddenFromSidebar == true)" }
        != bootstrap.channels.map { "\($0.id):\($0.name):\($0.hiddenFromSidebar == true)" }
    state.bootstrap = bootstrap
    let pendingNonces = Set(state.outbox.map(\.id))
    decideOnboarding()
    if !testing, directoryChanged { TeamAppShortcuts.updateAppShortcutParameters() }
    for (channel, messages) in Dictionary(grouping: bootstrap.latestMessages, by: \.channelId) {
      if var receipts = questionReceiptCaches[channel] {
        receipts.observe(messages)
        questionReceiptCaches[channel] = receipts
      }
      // Bootstrap carries only each channel's newest message. A loaded
      // transcript takes new messages from its next history page instead, so
      // earlier ones never appear above a newer one already on screen.
      // Previews read it through latestMessage(_:).
      if hasCachedHistory(channel) {
        let known = Set(self.messages(channel).map(\.id))
        let updates = messages.filter {
          known.contains($0.id) || $0.clientId.map { pendingNonces.contains($0) } == true
        }
        // A locally queued message must have its confirmed replacement installed
        // before bootstrap acceptance cancels the outstanding acknowledgement.
        if !updates.isEmpty {
          if updates.contains(where: { !known.contains($0.id) }) {
            state.incompleteHistoryChannels = (state.incompleteHistoryChannels ?? []).union([channel])
          }
          state.messages[channel] = questionAwareMerge(self.messages(channel), updates, channel: channel)
        }
      } else {
        merge(messages, channel: channel)
      }
    }
    confirmDelivery(bootstrap.latestMessages)
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
    if !testing, let record { SystemDiscovery.shared.update(session: record, state: savedSnapshot) }
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
    try stage(channel: channel) { try $0.stage(data, fileName: name, mimeType: mime) }
  }
  func stage(fileAt url: URL, name: String, mime: String, channel: String) throws {
    try stage(channel: channel) { try $0.stage(fileAt: url, fileName: name, mimeType: mime) }
  }
  private func stage(channel: String, write: (DiskStore) throws -> StagedFile) throws {
    guard let disk else { throw APIError("Connect to a server before attaching a file.") }
    var draft = draft(channel)
    guard draft.attachments.count + (draft.stagedFiles?.count ?? 0) < Draft.maxAttachments else {
      throw APIError("A message can contain up to \(Draft.maxAttachments) attachments.")
    }
    let file = try write(disk)
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
  func stagedFileURL(_ file: StagedFile) -> URL? { try? disk?.fileURL(file) }
  func removeStagedFile(_ file: StagedFile, channel: String) {
    var next = savedSnapshot
    next.drafts[channel]?.stagedFiles?.removeAll { $0.id == file.id }
    do {
      try commit(next)
      try disk?.removeFile(file)
    } catch { self.error = error.localizedDescription }
  }
  private func beginStateSync() -> UUID {
    if stateSyncs.isEmpty { syncUnavailable = false }
    let id = UUID()
    stateSyncs.insert(id)
    return id
  }
  @discardableResult
  func refresh(quiet: Bool = false, flushPending: Bool = true) async -> Bool {
    guard let api, phase == .ready else { return false }
    let epoch = generation
    // Independent of bootstrap/settings latency; keep saved icons on screen.
    Task { if epoch == generation { await refreshSidebarPlugins() } }
    let sync = beginStateSync()
    defer { stateSyncs.remove(sync) }
    do {
      let bootstrap = try await reactionMutations.read {
        try await api.get("/api/v0/client-bootstrap", as: Bootstrap.self)
      }
      guard epoch == generation, !Task.isCancelled else { return false }
      apply(bootstrap)
      online = true
      syncUnavailable = false
      persist()
      let root = try await api.request("/api/v0/settings")
      guard epoch == generation, !Task.isCancelled else { return false }
      if root["settings"]["sidebarPreferences"]["version"].int == 2 {
        applySidebarSnapshot(root["settings"]["sidebarPreferences"])
      }
      // Pending sends are separate from loading the main screen's state.
      stateSyncs.remove(sync)
      if flushPending { await flush() }
      return epoch == generation && !Task.isCancelled
    } catch {
      if epoch == generation { handle(error, quiet: quiet) }
      return false
    }
  }
  /// Shared by every footer instance. A recreated view reads SavedState
  /// synchronously and joins an in-flight refresh instead of resetting its icons.
  func refreshSidebarPlugins() async {
    guard phase == .ready else { return }
    let epoch = generation
    if let pending = sidebarPluginsRefresh, pending.epoch == epoch {
      await pending.task.value
      return
    }
    let id = UUID()
    sidebarPluginsVerified = false
    let task = Task { [weak self] in
      guard let self, generation == epoch else { return }
      guard let response = try? await request("/api/v0/plugins"),
        generation == epoch, phase == .ready, !Task.isCancelled,
        let plugins = SidebarPlugin.snapshot(response)
      else { return }
      state.sidebarPlugins = plugins
      sidebarPluginsVerified = true
      persist()
    }
    sidebarPluginsRefresh = (id, epoch, task)
    await task.value
    if sidebarPluginsRefresh?.id == id { sidebarPluginsRefresh = nil }
  }
  /// UI tests and QA opt in with `--qa-onboarding`; other UI-test fixtures never see it.
  private var onboardingForcedForQA: Bool {
    #if DEBUG
      return testing && ProcessInfo.processInfo.arguments.contains("--qa-onboarding")
    #else
      return false
    #endif
  }
  /// Decided once per connection from a fresh bootstrap. A server that already has
  /// bots and a model is remembered as set up, so established users never see it.
  private func decideOnboarding() {
    guard onboarding == .undecided, let bootstrap = state.bootstrap, let record else { return }
    if testing && !onboardingForcedForQA {
      onboarding = .hidden
    } else if OnboardingDecision.needed(bots: bootstrap.bots.count, runtime: runtime) {
      onboarding = .showing
    } else {
      onboarding = .hidden
      if !testing {
        UserDefaults.standard.set(true, forKey: OnboardingDecision.key(server: record.server))
      }
    }
  }
  /// Skip, finish or create the first bot. With the new bot's chat (`landing`), Home
  /// opens it and asks for notifications once its greeting has arrived; otherwise the
  /// question waits until Home has settled, so it never lands on top of a transition.
  func finishOnboarding(landing channel: String? = nil) {
    guard onboarding == .showing, let record else { return }
    if !testing {
      UserDefaults.standard.set(true, forKey: OnboardingDecision.key(server: record.server))
    }
    landing = channel.flatMap { self.channel($0) == nil ? nil : $0 }
    onboarding = .hidden
    if landing == nil { askForNotifications(after: .milliseconds(1200)) }
  }
  /// Home has zoomed into the first bot's chat and its greeting has arrived.
  func finishLanding() {
    guard landing != nil else { return }
    landing = nil
    askForNotifications(after: .zero)
  }
  private func askForNotifications(after delay: Duration) {
    #if canImport(UIKit)
      guard launchComplete else { return }
      Task {
        if delay > .zero { try? await Task.sleep(for: delay) }
        await NativeNotifications.shared.resume(requestPermission: true)
      }
    #endif
  }
  /// Reads only the server's readiness, after model or voice settings change.
  func refreshRuntime() async {
    guard let value = try? await request("/api/v0/client-runtime"), state.bootstrap != nil
    else { return }
    state.bootstrap?.runtime = value["runtime"]
    persist()
  }
  func finishLaunch() {
    launchComplete = true
    startEvents()
    #if canImport(UIKit)
      // Start WebKit before the first chat with a table or diagram opens; the
      // chat otherwise waits on a cold renderer behind its loading indicator.
      MessageDocuments.prewarm()
    #endif
  }
  func setForeground(_ active: Bool) {
    foreground = active
    #if canImport(UIKit)
      NativeNotifications.shared.setForeground(active)
    #endif
    if active {
      #if canImport(UIKit)
        if launchComplete { Task { await NativeNotifications.shared.resume() } }
      #endif
      startEvents()
    } else {
      lifecycle?.cancel()
      lifecycle = nil
      cancelConnectionCheck()
      stopBackgroundHistories()
      stateSyncs.removeAll()
      flushPersistence()
    }
  }
  /// Routines and the bot's computer follow the user's zone; report the one this iPhone detects
  /// each time the app comes forward, so travel moves them too. The server ignores repeats.
  private func reportTimeZone() {
    guard let api else { return }
    let zone = TimeZone.current.identifier
    Task {
      _ = try? await api.request(
        "/api/v0/time-zone", method: "PATCH", body: .object(["detectedTimeZone": .string(zone)]))
    }
  }
  private func startEvents() {
    lifecycle?.cancel()
    guard phase == .ready, foreground, launchComplete || testing else { return }
    let epoch = generation
    syncUnavailable = false
    let sync = beginStateSync()
    catchUpSync = sync
    awaitingInitialSync = false
    reportTimeZone()
    lifecycle = Task { [weak self] in
      guard let self else { return }
      // Retain incomplete startup work independently of reachability and of
      // other requests changing the loading indicator while startup is running.
      var needsReconciliation = !(await refreshSession(epoch: epoch, sync: sync))
      guard epoch == generation, !Task.isCancelled, phase == .ready else { return }
      // Sending may include a progressing upload. Keep consuming acceptance
      // events while it runs so acknowledgement reconciliation stays responsive.
      Task { if epoch == generation { await flush() } }
      guard epoch == generation, !Task.isCancelled, phase == .ready else { return }
      if let activeChannel { await loadHistory(activeChannel) }
      syncBackgroundHistories(epoch: epoch)
      var cursor = state.bootstrap?.cursor ?? "0"
      var delay: UInt64 = 1
      while !Task.isCancelled, epoch == generation, phase == .ready, let api {
        do {
          let wasOnline = online
          let batch = try await api.get(
            "/api/v0/events/poll", as: EventBatch.self, query: ["after": cursor, "waitMs": "25000"])
          try Task.checkCancellation()
          guard epoch == generation else { return }
          // Reachability can recover through another request before this poll.
          // Retain failed reconciliation work independently of connection state.
          let reconnectSync = !wasOnline || needsReconciliation ? beginStateSync() : nil
          defer { if let reconnectSync { stateSyncs.remove(reconnectSync) } }
          online = true
          if reconnectSync != nil || !batch.events.isEmpty
            || activeChannel.map({ historyLoadFailures.contains($0) }) == true
          {
            // Reconcile authoritative bounded projections. Advance the cursor only after reconciliation succeeds.
            let bootstrap = try await reactionMutations.read {
              try await api.get("/api/v0/client-bootstrap", as: Bootstrap.self)
            }
            try Task.checkCancellation()
            guard epoch == generation else { return }
            apply(bootstrap)
            if reconnectSync != nil {
              Task { if epoch == generation { await refreshSidebarPlugins() } }
              let root = try await api.request("/api/v0/settings")
              try Task.checkCancellation()
              guard epoch == generation else { return }
              if root["settings"]["sidebarPreferences"]["version"].int == 2 {
                applySidebarSnapshot(root["settings"]["sidebarPreferences"])
              }
            }
            if let activeChannel {
              try await fetchHistory(activeChannel, before: nil, api: api, epoch: epoch)
            }
            syncBackgroundHistories(epoch: epoch)
            cursor = bootstrap.cursor
            persist()
          }
          syncUnavailable = false
          needsReconciliation = false
          delay = 1
          if let reconnectSync { stateSyncs.remove(reconnectSync) }
          Task { if epoch == generation { await flush() } }
        } catch {
          if Task.isCancelled || epoch != generation { return }
          needsReconciliation = true
          handle(error, quiet: true)
          try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
          delay = min(delay * 2, 30)
        }
      }
    }
  }
  private func refreshSession(epoch: UUID, sync: UUID) async -> Bool {
    defer { stateSyncs.remove(sync) }
    if needsIdentityRefresh, let saved = record {
      do {
        let updated = try await saved.refreshIdentity(
          fetch: {
            do {
              return try await API(server: saved.server, token: saved.token, timeout: 15)
                .request("/api/auth/get-session")
            } catch {
              if epoch == generation, !Task.isCancelled { handle(error, quiet: true) }
              throw error
            }
          }, save: { updated in
            // A response from before Re-auth must never recreate the old
            // Keychain entry or overwrite a newly connected account.
            try Task.checkCancellation()
            guard epoch == self.generation else { throw CancellationError() }
            try SecureSession.save(updated)
          })
        guard epoch == generation, !Task.isCancelled else { return false }
        record = updated
        userName = updated.displayName
        needsIdentityRefresh = false
      } catch {
        guard epoch == generation, !Task.isCancelled else { return false }
        handle(APIError("Your session expired. Sign in again.", status: 401))
        return false
      }
    }
    return await refresh(quiet: true, flushPending: false)
  }
  /// Replies keep landing in chats that are not open, usually with a notification.
  /// Read the newest page of those chats in the background, one at a time, so
  /// opening one shows the reply instead of waiting for it.
  private func syncBackgroundHistories(epoch: UUID) {
    for channel in channels
    where !backgroundHistoryQueue.contains(channel.id) && backgroundHistoryNeeded(channel.id) {
      backgroundHistoryQueue.append(channel.id)
    }
    guard backgroundHistories == nil, !backgroundHistoryQueue.isEmpty else { return }
    backgroundHistories = Task { [weak self] in
      while let self, epoch == self.generation, !Task.isCancelled, let api = self.api,
        !self.backgroundHistoryQueue.isEmpty
      {
        let id = self.backgroundHistoryQueue.removeFirst()
        guard self.backgroundHistoryNeeded(id) else { continue }
        // Opening this chat meanwhile waits for this read instead of starting another.
        self.busy.insert("history-" + id)
        try? await self.fetchHistory(id, before: nil, api: api, epoch: epoch)
        self.busy.remove("history-" + id)
      }
      guard let self, epoch == self.generation, !Task.isCancelled else { return }
      self.backgroundHistories = nil
    }
  }
  private func stopBackgroundHistories() {
    backgroundHistories?.cancel()
    backgroundHistories = nil
    backgroundHistoryQueue.removeAll()
  }
  /// A saved transcript that lacks the chat's newest message, or an unread chat
  /// that was never loaded. The open chat already reads its own history.
  private func backgroundHistoryNeeded(_ id: String) -> Bool {
    guard id != activeChannel, !busy.contains("history-" + id),
      let channel = channel(id), channel.kind != "agent_dm"
    else { return false }
    guard hasCachedHistory(id) else {
      return (channel.unreadCount ?? 0) > 0
        && state.bootstrap?.latestMessages.contains(where: { $0.channelId == id }) == true
    }
    return transcriptBehind(id)
  }
  func loadHistory(_ id: String, older: Bool = false) async {
    guard let api, !busy.contains("history-" + id),
      older || historyWindows[id]?.hasLater != true else { return }
    let epoch = generation
    busy.insert("history-" + id)
    defer { busy.remove("history-" + id) }
    do {
      try await fetchHistory(
        id, before: older ? histories[id]?.beforeSequence : nil, api: api, epoch: epoch)
    } catch {
      if epoch == generation, !Task.isCancelled,
        !(error is CancellationError), (error as? URLError)?.code != .cancelled
      {
        if !older, historyWindows[id]?.hasLater != true { historyLoadFailures.insert(id) }
        // Loading errors belong to the transcript; cached messages stay readable.
        handle(error, quiet: true)
      }
    }
  }
  private func fetchHistory(_ id: String, before: String?, api: API, epoch: UUID) async throws {
    // Poll reconciliation also comes here. A search context already has its
    // own contiguous page; only explicit pagination should extend that window.
    guard before != nil || historyWindows[id]?.hasLater != true else { return }
    let windowID = historyWindows[id]?.id
    let opening = historyOpenings[id]
    var query = ["limit": "60"]
    if let before { query["before"] = before }
    let page: History
    do {
      page = try await reactionMutations.read {
        try await api.get(
          "/api/v0/channels/\(API.segment(id))/history", as: History.self, query: query)
      }
    } catch {
      // Superseded reads must not reach the caller's error handling either.
      guard epoch == generation, !Task.isCancelled,
        historyWindows[id]?.id == windowID, historyOpenings[id] == opening else { return }
      // Pagination failures keep their cursor for an explicit retry; they must
      // not make event polling repeatedly fetch a disconnected latest page.
      if before == nil, historyWindows[id]?.hasLater != true,
        epoch == generation, !UserFacingError.isCancelled(error) {
        historyLoadFailures.insert(id)
      }
      throw error
    }
    guard epoch == generation, !Task.isCancelled,
      historyWindows[id]?.id == windowID, historyOpenings[id] == opening else { return }
    historyLoadFailures.remove(id)
    confirmDelivery(page.threadContext + page.messages)
    // A page can have been captured before a newer notification arrived.
    if before == nil {
      if let announced = notifiedLatest[id],
        let newest = page.messages.last?.sequence, !MessageMerge.less(newest, announced) {
        notifiedLatest[id] = nil
      }
      state.incompleteHistoryChannels?.remove(id)
    }
    if before != nil {
      state.messages[id] = questionAwareMerge(messages(id), page.threadContext + page.messages, channel: id)
      historyWindows[id]?.extend(page.messages, earlier: true, hasMore: page.hasMore)
      histories[id] = page
    } else if histories[id] == nil {
      install(page)
    } else {
      // A search result is a continuous older window, not an invitation to append
      // a disconnected latest page. Polling may still update rows in that window.
      merge(page.threadContext + page.messages, channel: id)
    }
    persist()
  }
  func merge(_ incoming: [Message], channel: String) {
    let existing = messages(channel)
    let ids = Set(existing.map(\.id))
    let visible = incoming.filter {
      ids.contains($0.id) || historyWindows[channel]?.contains($0) != false
    }
    state.messages[channel] = questionAwareMerge(existing, visible, channel: channel, observed: incoming)
    confirmDelivery(incoming)
  }
  private func confirmDelivery(_ incoming: [Message]) {
    let accepted = Set(incoming.compactMap(\.clientId))
    let files = state.outbox.filter { accepted.contains($0.id) }.flatMap { $0.stagedFiles ?? [] }
    state.outbox.removeAll { accepted.contains($0.id) }
    for file in files { try? disk?.removeFile(file) }
  }
  private func install(_ page: History) {
    state.incompleteHistoryChannels?.remove(page.channelId)
    confirmDelivery(page.threadContext + page.messages)
    state.loadedHistoryChannels = (state.loadedHistoryChannels ?? []).union([page.channelId])
    histories[page.channelId] = page
    historyWindows[page.channelId] = HistoryWindow(
      messages: page.messages, hasEarlier: page.hasMore, hasLater: false)
    state.messages[page.channelId] = questionAwareMerge(page.threadContext, page.messages, channel: page.channelId)
  }
  @discardableResult
  func loadContext(_ channelID: String, messageID: String, preservingTimeline: Bool = false,
    opening: UUID? = nil, historyOpening: UUID? = nil) async -> Bool {
    guard let api,
      historyOpening == nil || historyOpenings[channelID] == historyOpening else { return false }
    let epoch = generation
    let navigation = opening ?? navigationGeneration
    let windowID = historyWindows[channelID]?.id
    // Replacements supersede pending page/replacement reads as soon as they start.
    // Importing a reply's thread context keeps the current timeline's ownership.
    let request = historyOpening ?? (preservingTimeline ? historyOpenings[channelID] : UUID())
    if !preservingTimeline { historyOpenings[channelID] = request }
    do {
      let page = try await reactionMutations.read {
        try await api.get(
          "/api/v0/channel-messages/\(API.segment(messageID))/context", as: MessageContext.self)
      }
      guard epoch == generation, !Task.isCancelled,
        navigationGeneration == navigation, historyOpenings[channelID] == request,
        !preservingTimeline || historyWindows[channelID]?.id == windowID else { return false }
      guard page.channelId == channelID else {
        throw APIError("This message belongs to another conversation.")
      }
      confirmDelivery(page.threadContext + page.messages)
      if preservingTimeline {
        state.messages[channelID] = questionAwareMerge(messages(channelID), page.threadContext + page.messages, channel: channelID)
        persist()
        return true
      }
      historyLoadFailures.remove(channelID)
      state.messages[channelID] = questionAwareMerge(page.threadContext, page.messages, channel: page.channelId)
      historyWindows[channelID] = HistoryWindow(
        messages: page.messages, hasEarlier: page.hasMoreBefore, hasLater: page.hasMoreAfter)
      histories[channelID] = History(
        channelId: channelID, messages: [], threadContext: [], beforeSequence: page.beforeSequence,
        hasMore: page.hasMoreBefore, revision: page.revision)
      persist()
      return true
    } catch {
      if epoch == generation, !Task.isCancelled, navigationGeneration == navigation,
        historyOpenings[channelID] == request,
        !preservingTimeline || historyWindows[channelID]?.id == windowID { handle(error) }
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
    let windowID = historyWindows[channelID]?.id
    let opening = historyOpenings[channelID]
    do {
      let page = try await reactionMutations.read {
        try await api.get(
          "/api/v0/channel-messages/\(API.segment(last.id))/context", as: MessageContext.self,
          query: ["direction": "after", "limit": "60"])
      }
      guard epoch == generation, !Task.isCancelled,
        historyWindows[channelID]?.id == windowID,
        historyOpenings[channelID] == opening else { return }
      guard page.channelId == channelID else { throw APIError("The conversation changed.") }
      confirmDelivery(page.threadContext + page.messages)
      state.messages[channelID] = questionAwareMerge(messages(channelID), page.threadContext + page.messages, channel: channelID)
      historyWindows[channelID]?.extend(page.messages, earlier: false, hasMore: page.hasMoreAfter)
      persist()
    } catch {
      if epoch == generation, !Task.isCancelled, historyWindows[channelID]?.id == windowID,
        historyOpenings[channelID] == opening {
        handle(error)
      }
    }
  }
  @discardableResult
  func loadLatest(_ channelID: String, opening: UUID? = nil, historyOpening: UUID? = nil) async -> Bool {
    guard let api,
      historyOpening == nil || historyOpenings[channelID] == historyOpening else { return false }
    let epoch = generation
    let navigation = opening ?? navigationGeneration
    let request = historyOpening ?? UUID()
    historyOpenings[channelID] = request
    do {
      let page = try await reactionMutations.read {
        try await api.get(
          "/api/v0/channels/\(API.segment(channelID))/history", as: History.self, query: ["limit": "60"])
      }
      guard epoch == generation, !Task.isCancelled,
        navigationGeneration == navigation, historyOpenings[channelID] == request else { return false }
      install(page)
      persist()
      return true
    } catch {
      if epoch == generation, !Task.isCancelled, navigationGeneration == navigation,
        historyOpenings[channelID] == request { handle(error) }
      return false
    }
  }
  @discardableResult
  func markRead(_ id: String, through sequence: String? = nil,
    throughNotificationSequence: String? = nil, fromInbox: Bool = false) async -> Bool {
    guard !Task.isCancelled, foreground, (fromInbox || activeChannel == id), let api,
      channel(id) != nil
    else { return false }
    let through =
      sequence ?? messages(id).last(where: { !$0.metadata["branched"].bool })?.sequence ?? "0"
    let notificationCursor =
      NotificationReads.sequence(throughNotificationSequence
        ?? channel(id)?.notificationState?["notificationCursor"].string ?? "")
      ?? "0"
    let previousActivity =
      NotificationReads.sequence(
        channel(id)?.notificationState?["lastReadNotificationSequence"].string ?? "") ?? "0"
    let previous = channel(id)?.notificationState?["lastReadSequence"].string ?? ""
    if !previous.isEmpty, !MessageMerge.less(previous, through),
      !MessageMerge.less(previousActivity, notificationCursor), channel(id)?.unreadCount == 0,
      !sidebar["unreadIds"].array.contains(.string(id))
    {
      return true
    }
    let epoch = generation
    let messageFrontier = unreadMessageFrontier(id)
    let activityFrontier = channel(id)?.notificationState?["notificationCursor"].string ?? "0"
    let unreadIntent = unreadIntents[id]
    do {
      let value = try await api.request(
        "/api/v0/channels/\(API.segment(id))/read", method: "POST",
        body: .object([
          "throughSequence": .string(through),
          "throughNotificationSequence": .string(notificationCursor),
        ]))
      guard epoch == generation, !Task.isCancelled,
        let index = state.bootstrap?.channels.firstIndex(where: { $0.id == id })
      else { return false }
      var notification = state.bootstrap?.channels[index].notificationState ?? .object([:])
      let acknowledgedMessage = value["lastReadSequence"] == .null
        ? through : value["lastReadSequence"].string
      let acknowledgedActivity = value["lastReadNotificationSequence"] == .null
        ? notificationCursor : value["lastReadNotificationSequence"].string
      let currentMessage = notification["lastReadSequence"].string
      let currentActivity = notification["lastReadNotificationSequence"].string
      // Counts describe the message/activity frontier observed by this request.
      // Read cursors alone do not change when a newer unread item arrives.
      if !MessageMerge.less(acknowledgedMessage, currentMessage),
        !MessageMerge.less(acknowledgedActivity, currentActivity),
        !MessageMerge.less(messageFrontier, unreadMessageFrontier(id)),
        !MessageMerge.less(activityFrontier, notification["notificationCursor"].string) {
        state.bootstrap?.channels[index].unreadCount = value["unreadCount"].int
      }
      notification["lastReadSequence"] = .string(
        MessageMerge.less(currentMessage, acknowledgedMessage) ? acknowledgedMessage : currentMessage)
      notification["lastReadNotificationSequence"] = .string(
        MessageMerge.less(currentActivity, acknowledgedActivity) ? acknowledgedActivity : currentActivity)
      state.bootstrap?.channels[index].notificationState = notification
      #if canImport(UIKit)
        NativeNotifications.shared.apply(channels: channels)
      #endif
      persist()
      _ = await writeSidebar(api: api, epoch: epoch, quiet: true,
        accepting: { self.unreadIntents[id] == unreadIntent }) {
        guard self.sidebar["unreadIds"].array.contains(.string(id)) else { return nil }
        var next = self.sidebar
        next["unreadIds"] = .array(next["unreadIds"].array.filter { $0 != .string(id) })
        return next
      }
      return epoch == generation && !Task.isCancelled
    } catch {
      if epoch == generation { handle(error, quiet: true) }
      return false
    }
  }
  private func unreadMessageFrontier(_ id: String) -> String {
    [latestMessage(id)?.sequence, notifiedLatest[id]].compactMap { $0 }
      .max { MessageMerge.less($0, $1) } ?? "0"
  }
  private func applySidebarSnapshot(_ snapshot: JSON) {
    let previous = Set(sidebar["unreadIds"].array)
    for id in snapshot["unreadIds"].array where !previous.contains(id) {
      unreadIntents[id.string] = UUID()
    }
    sidebar = snapshot
  }
  /// Apply the caller's changes to the sidebar present when its queued PATCH
  /// starts. Unchanged fields and independently added IDs retain newer values.
  private func rebaseSidebar(_ desired: JSON, from base: JSON, onto current: JSON) -> JSON {
    guard desired != base else { return current }
    if case .object(let fields) = desired, case .object(var result) = current {
      for key in Set(base.object.keys).union(fields.keys) where base.object[key] != fields[key] {
        result[key] = fields[key].map {
          rebaseSidebar($0, from: base[key], onto: current[key])
        }
      }
      return .object(result)
    }
    guard case .array(let items) = desired, case .array(let latest) = current else { return desired }
    let baseIDs = base.array.map(sidebarItemID)
    let desiredIDs = items.map(sidebarItemID)
    let currentIDs = latest.map(sidebarItemID)
    guard [baseIDs, desiredIDs, currentIDs].allSatisfy({
      !$0.contains("") && Set($0).count == $0.count
    }) else { return desired }
    let originals = Dictionary(uniqueKeysWithValues: zip(baseIDs, base.array))
    var values = Dictionary(uniqueKeysWithValues: zip(currentIDs, latest))
    for (id, item) in zip(desiredIDs, items) {
      values[id] = rebaseSidebar(item, from: originals[id] ?? .null, onto: values[id] ?? .null)
    }
    var order = currentIDs
    for change in desiredIDs.difference(from: baseIDs) {
      switch change {
      case .remove(_, let id, _):
        order.removeAll { $0 == id }
      case .insert(let offset, let id, _):
        order.removeAll { $0 == id }
        if let previous = desiredIDs[..<offset].last(where: { order.contains($0) }),
          let index = order.firstIndex(of: previous) {
          order.insert(id, at: index + 1)
        } else if let next = desiredIDs.dropFirst(offset + 1).first(where: { order.contains($0) }),
          let index = order.firstIndex(of: next) {
          order.insert(id, at: index)
        } else {
          order.append(id)
        }
      }
    }
    return .array(order.compactMap { values[$0] })
  }
  private func sidebarItemID(_ item: JSON) -> String {
    item["id"].string.isEmpty ? item.string : item["id"].string
  }
  /// Read clears and UI sidebar mutations share request ordering. A clear must
  /// finish before a newer explicit Mark unread PATCH reaches the server.
  private func writeSidebar(api: API, epoch: UUID, quiet: Bool = false,
    refreshAfterWrite: Bool = false,
    accepting: @escaping @MainActor () -> Bool = { true },
    body: @escaping @MainActor () -> JSON?) async -> JSON? {
    guard epoch == generation, !Task.isCancelled, accepting() else { return nil }
    let pending = sidebarWrite?.task
    let id = UUID()
    // Finish a submitted write even if its caller is cancelled. Cancelling its
    // transport could release the queue before the server applies the PATCH.
    let task = Task<JSON?, Never> { @MainActor in
      _ = await pending?.value
      guard epoch == generation, accepting(), let next = body() else { return nil }
      do {
        let saved = try await api.request("/api/v0/settings/sidebar", method: "PATCH", body: next)
        guard epoch == generation, accepting() else { return nil }
        sidebar = saved
        if refreshAfterWrite { await refresh() }
        guard epoch == generation else { return nil }
        return saved
      } catch {
        if epoch == generation { handle(error, quiet: quiet) }
        return nil
      }
    }
    sidebarWrite = (id, task)
    let saved = await task.value
    // Existing view callers assign the returned sidebar. Only the last queued
    // writer may return a value, so an earlier caller cannot reinstall its copy.
    guard sidebarWrite?.id == id else { return nil }
    sidebarWrite = nil
    return epoch == generation && !Task.isCancelled ? saved : nil
  }
  func enqueue(_ channel: Channel, draftKey: String? = nil, threadRootID: String? = nil,
    replyRootID: String? = nil) async {
    let key = draftKey ?? channel.id
    let current = draft(key)
    guard
      !current.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || !current.attachments.isEmpty || !(current.stagedFiles ?? []).isEmpty
    else { return }
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
      requestedSendIDs.insert(id)
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
        + (pending.stagedFiles?.count ?? 0) <= Draft.maxAttachments
    else {
      error =
        "This draft would have more than \(Draft.maxAttachments) attachments. Choose another conversation or remove an attachment from its draft first."
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
    guard let api else { return }
    guard !sending else {
      flushRequested = true
      return
    }
    sending = true
    let epoch = generation
    defer {
      if epoch == generation {
        sending = false
        activeSendID = nil
        checkingSendID = nil
        sendRetryCounts = [:]
        if flushRequested {
          flushRequested = false
          Task { await flush() }
        }
      }
    }
    // One request per nonce at a time; after a timeout, reconcile before resubmitting that same nonce.
    for pending in state.outbox where pending.failure == nil
      && (pending.deliveryUnconfirmed != true || requestedSendIDs.contains(pending.id))
    {
      requestedSendIDs.remove(pending.id)
      activeSendID = pending.id
      sendRetryCounts[pending.id] = 0
      checkingSendID = pending.deliveryUnconfirmed == true ? pending.id : nil
      guard epoch == generation, !Task.isCancelled else { return }
      guard let channel = channel(pending.channelId) else {
        if let index = state.outbox.firstIndex(where: { $0.id == pending.id }) {
          state.outbox[index].failure =
            "This conversation is no longer available. Your unsent message remains saved on this iPhone."
          persist()
        }
        continue
      }
      // Progress extends the stall window, but never the overall cap. Repeated polls,
      // response bytes and re-uploading the same prefix do not count as progress.
      let budget = SendProgressBudget(stall: sendStallTimeout, overall: sendOverallTimeout)
      var backoff: Duration = .milliseconds(500)
      var lastDeliveryStatus: String?
      var submitting = false
      var uncertainBeforeSubmission = false
      sendAttempt: while true {
        guard epoch == generation, !Task.isCancelled else { return }
        guard let current = state.outbox.first(where: { $0.id == pending.id }) else { break }
        do {
          let delivery = try await sendOperation(id: pending.id, epoch: epoch, budget: budget) {
            try await api.get(
              "/api/v0/channels/\(API.segment(channel.id))/message-deliveries/\(API.segment(pending.id))",
              as: DeliveryStatus.self, timeout: budget.overallRemaining())
          }
          guard epoch == generation else { return }
          if let message = delivery.message {
            merge([message], channel: channel.id)
            persist()
            break sendAttempt
          }
          if delivery.status != lastDeliveryStatus {
            if lastDeliveryStatus != nil || delivery.status != "not_found" { budget.progress() }
            lastDeliveryStatus = delivery.status
          }
          if ["pending", "unknown_durability", "accepted"].contains(delivery.status) {
            checkingSendID = pending.id
            if let index = state.outbox.firstIndex(where: { $0.id == pending.id }) {
              state.outbox[index].deliveryUnconfirmed = true
              persist()
            }
            // The server contract returns the durable message for accepted delivery.
            // An accepted-only malformed reply cannot erase the saved local content;
            // keep checking without resubmitting until history or a valid lookup arrives.
            throw SendPollingError.awaitingDelivery
          }
          if delivery.status == "rejected" {
            if let index = state.outbox.firstIndex(where: { $0.id == pending.id }) {
              state.outbox[index].deliveryUnconfirmed = false
            }
            throw APIError(delivery.messageText ?? "The server rejected this message.", status: 422)
          }
          guard delivery.status == "not_found" else {
            throw APIError("The server returned an invalid delivery status.")
          }
          for file in current.stagedFiles ?? [] {
            guard let disk else { throw APIError("The saved attachment is unavailable.") }
            let bytes = try Data(contentsOf: disk.fileURL(file))
            let (data, _) = try await sendOperation(id: pending.id, epoch: epoch, budget: budget) {
              try await api.raw(
                "/api/v0/assets", method: "POST", data: bytes, contentType: file.mimeType,
                headers: [
                  "x-file-name": file.fileName.addingPercentEncoding(
                    withAllowedCharacters: .alphanumerics) ?? "File"
                ], timeout: budget.overallRemaining(),
                uploadProgress: { budget.uploadProgress(file: file.id, bytes: $0) })
            }
            guard epoch == generation,
              let index = state.outbox.firstIndex(where: { $0.id == pending.id })
            else { return }
            let asset = try JSONDecoder().decode(Asset.self, from: data)
            var next = savedSnapshot
            next.outbox[index].input.attachments.append(asset)
            next.outbox[index].uploadedFileIDs = next.outbox[index].uploadedFileIDs ?? [:]
            next.outbox[index].uploadedFileIDs?[asset.assetId + ":" + asset.fileName] = file.id
            next.outbox[index].stagedFiles?.removeAll { $0.id == file.id }
            try commit(next)
            try? disk.removeFile(file)
            budget.progress()
          }
          guard let committed = state.outbox.first(where: { $0.id == pending.id }) else {
            break sendAttempt
          }
          try budget.check()
          guard let index = state.outbox.firstIndex(where: { $0.id == pending.id }) else {
            break sendAttempt
          }
          // Commit uncertainty BEFORE the side effect, including across process termination.
          uncertainBeforeSubmission = committed.deliveryUnconfirmed == true
          var next = savedSnapshot
          next.outbox[index].deliveryUnconfirmed = true
          try commit(next)
          submitting = true
          let targetBot = bot(for: channel)
          let message = try await sendOperation(id: pending.id, epoch: epoch, budget: budget) {
            try await api.send(
              channel: channel, bot: targetBot, input: committed.input,
              timeout: budget.overallRemaining())
          }
          submitting = false
          #if canImport(UIKit)
            let donatedBot = bot(for: channel)
            Task {
              let image = await ConversationDonation.avatar(
                channel: channel, bot: donatedBot, api: api)
              ConversationDonation.donateSent(channel: channel, bot: donatedBot, image: image)
            }
          #endif
          guard epoch == generation else { return }
          merge([message], channel: channel.id)
          persist()
          break sendAttempt
        } catch {
          guard epoch == generation, !Task.isCancelled else { return }
          guard state.outbox.contains(where: { $0.id == pending.id }) else { break sendAttempt }
          if submitting {
            // Explicit validation/auth responses and failures to establish a connection
            // prove this submission failed. Timeouts, connection loss and 5xx do not.
            if Self.definitelyDidNotSubmit(error), !uncertainBeforeSubmission,
              let index = state.outbox.firstIndex(where: { $0.id == pending.id })
            {
              state.outbox[index].deliveryUnconfirmed = false
              persist()
            }
            submitting = false
            if state.outbox.first(where: { $0.id == pending.id })?.deliveryUnconfirmed == true {
              checkingSendID = pending.id
            }
          }
          if Self.canRetrySend(error), !(error is SendPollingError) {
            sendRetryCounts[pending.id, default: 0] += 1
          }
          if Self.canRetrySend(error), budget.remaining > .zero {
            let pause = min(backoff, budget.remaining)
            do { try await Task.sleep(for: pause) } catch { return }
            backoff = min(backoff * 2, .seconds(2))
            continue sendAttempt
          }
          guard !UserFacingError.isCancelled(error) else { return }
          if (error as? APIError)?.unauthorized == true {
            handle(error, quiet: true)
            return
          }
          if let i = state.outbox.firstIndex(where: { $0.id == pending.id }) {
            // A potentially accepted message is not a delivery failure. Leave it parked
            // for explicit Retry (same nonce) or removal by incoming acceptance/history.
            if state.outbox[i].deliveryUnconfirmed != true {
              #if canImport(UIKit)
                NativeHaptics.failure(error, source: "message.send")
              #endif
              state.outbox[i].failure = UserFacingError.message(
                error is SendPollingError ? URLError(.timedOut) : error)
            }
            persist()
          }
          if !(error is SendPollingError) { handle(error, quiet: true) }
        }
        break sendAttempt
      }
    }
  }
  /// Cancellation also stops a hung request when history/events accepted the nonce,
  /// the user discarded it, or the authenticated account changed.
  private func sendOperation<T: Sendable>(
    id: String, epoch: UUID, budget: SendProgressBudget,
    operation: @escaping @Sendable () async throws -> T
  ) async throws -> T {
    try budget.check()
    guard epoch == generation, state.outbox.contains(where: { $0.id == id }) else {
      throw CancellationError()
    }
    let request = Task { try await operation() }
    let watchdog = Task { @MainActor in
      while !Task.isCancelled {
        if epoch != generation || !state.outbox.contains(where: { $0.id == id })
          || budget.remaining <= .zero
        {
          request.cancel()
          return
        }
        do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
      }
    }
    defer { watchdog.cancel(); request.cancel() }
    return try await withTaskCancellationHandler {
      do {
        let result = try await request.value
        try Task.checkCancellation()
        guard epoch == generation, state.outbox.contains(where: { $0.id == id }) else {
          throw CancellationError()
        }
        // A completed acknowledgement is authoritative, including when the
        // deadline passes during its completion. The watchdog bounds requests
        // still in flight; it must not discard a successful response we have.
        return result
      } catch {
        if epoch == generation, state.outbox.contains(where: { $0.id == id }),
          !Task.isCancelled, budget.remaining <= .zero
        {
          throw SendPollingError.deadlineReached
        }
        throw error
      }
    } onCancel: {
      request.cancel()
      watchdog.cancel()
    }
  }
  private static func definitelyDidNotSubmit(_ error: Error) -> Bool {
    if let error = error as? APIError {
      return (400..<500).contains(error.status) && error.status != 408
    }
    guard let error = error as? URLError else { return false }
    switch error.code {
    case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .notConnectedToInternet,
      .internationalRoamingOff, .callIsActive, .dataNotAllowed:
      return true
    default: return false
    }
  }
  private static func canRetrySend(_ error: Error) -> Bool {
    if error is SendPollingError { return true }
    if let error = error as? APIError {
      return error.status == 408 || error.status == 429 || error.status >= 500
    }
    guard let error = error as? URLError else { return false }
    switch error.code {
    case .timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost,
      .dnsLookupFailed, .notConnectedToInternet, .internationalRoamingOff,
      .callIsActive, .dataNotAllowed, .resourceUnavailable:
      return true
    default: return false
    }
  }
  @discardableResult
  func react(_ emoji: String, to message: Message) -> Bool {
    guard api != nil else { return false }
    let epoch = generation
    let current = messages(message.channelId).first { $0.id == message.id } ?? message
    if !reactionMutations.uncertain.contains(message.id) { error = nil }
    return reactionMutations.toggle(
      messageID: message.id, metadata: current.metadata, emoji: emoji,
      send: { [weak self] emoji in
        guard let self, self.generation == epoch else { throw CancellationError() }
        let result = try await self.request(
          "/api/v0/channel-messages/\(API.segment(message.id))/reaction", method: "POST",
          body: .object([
            "emoji": .string(emoji), "clientId": .string(UUID().uuidString),
            "timeZone": .string(TimeZone.current.identifier),
          ]))
        return try result["message"].decode(Message.self)
      },
      confirmed: { [weak self] updated in
        guard let self, self.generation == epoch else { return }
        var current = self.messages(updated.channelId).first { $0.id == updated.id } ?? updated
        current.metadata = ReactionMutations.replacingOwn(
          current.metadata, with: ReactionMutations.ownEmoji(updated.metadata))
        self.merge([current], channel: updated.channelId)
        self.persist()
      },
      recover: { [weak self] failure in
        guard let self, self.generation == epoch else { return false }
        self.handle(failure)
        NativeHaptics.failure(failure, source: "message.reaction")
        // A timeout may have committed. Read this message before accepting
        // another toggle; never replay an unknown mutation automatically.
        do {
          let page = try await self.reactionMutations.read {
            try await self.fetch(
              "/api/v0/channel-messages/\(API.segment(message.id))/context", as: MessageContext.self)
          }
          guard self.generation == epoch, page.channelId == message.channelId,
            let updated = (page.messages + page.threadContext).first(where: { $0.id == message.id })
          else { return false }
          self.merge([updated], channel: updated.channelId)
          self.persist()
          return true
        } catch { return false }
      })
  }
  @discardableResult
  func mutate(
    _ path: String, method: String = "POST", body: JSON? = nil,
    successFeedback: HapticEffect? = nil, feedbackSource: String = "mutation"
  ) async -> JSON? {
    if path == "/api/v0/settings/sidebar", method == "PATCH", let body, let api {
      guard !Task.isCancelled else { return nil }
      let base = sidebar
      // A carried-forward marker is not a new Mark unread action.
      let previousUnread = Set(base["unreadIds"].array)
      for id in body["unreadIds"].array where !previousUnread.contains(id) {
        unreadIntents[id.string] = UUID()
      }
      let saved = await writeSidebar(api: api, epoch: generation, refreshAfterWrite: true) {
        self.rebaseSidebar(body, from: base, onto: self.sidebar)
      }
      #if canImport(UIKit)
        if saved != nil, let successFeedback {
          NativeHaptics.play(successFeedback, source: feedbackSource)
        }
      #endif
      return saved
    }
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
    _ path: String, method: String = "GET", body: JSON? = nil, query: [String: String] = [:],
    timeout: TimeInterval? = nil
  ) async throws -> JSON {
    guard let api else { throw APIError("Sign in to continue.", status: 401) }
    let epoch = generation
    do {
      let result = try await api.request(
        path, method: method, body: body, query: query, timeout: timeout)
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
  func markUnread(_ id: String) async {
    guard let api, !Task.isCancelled else { return }
    // Record the targeted action even if this chat is already marked unread.
    unreadIntents[id] = UUID()
    _ = await writeSidebar(api: api, epoch: generation, refreshAfterWrite: true) {
      var next = self.sidebar
      var ids = next["unreadIds"].array
      if !ids.contains(.string(id)) { ids.append(.string(id)) }
      next["unreadIds"] = .array(ids)
      return next
    }
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
  func open(_ channelID: String, messageID: String? = nil) async {
    focusedNotification = nil
    let epoch = generation
    let opening = UUID()
    navigationGeneration = opening
    if let messageID {
      guard await loadContext(channelID, messageID: messageID, opening: opening) else { return }
    }
    guard epoch == generation, navigationGeneration == opening, !Task.isCancelled else { return }
    focusedMessage = messageID
    navigation = [channelID]
  }
  /// A notification opens its message even when this chat is already showing
  /// an older search window. Cached visible messages need no network round trip.
  func openNotification(_ channelID: String, messageID: String?, sequence: String?) async {
    let epoch = generation
    let opening = UUID()
    navigationGeneration = opening
    openingNotification = opening
    defer { if openingNotification == opening { openingNotification = nil } }
    noteNotified(channelID, sequence: sequence)
    let cached = messages(channelID).first {
      messageID == nil ? $0.sequence == sequence : $0.id == messageID
    }
    let cachedVisible = cached.map {
      hasCachedHistory(channelID) && historyWindows[channelID]?.contains($0) == true
        && !$0.metadata["branched"].bool
    } == true
    var resolvedID = messageID ?? cached?.id
    if resolvedID == nil, let preview = latestMessage(channelID), preview.sequence == sequence {
      resolvedID = preview.id
    }
    // Own the whole opening, including a legacy lookup and its follow-on fetch.
    // Cached targets keep the current ownership so its adjacent pages can finish.
    let request = cachedVisible ? historyOpenings[channelID] : UUID()
    if !cachedVisible {
      historyOpenings[channelID] = request
      if resolvedID == nil, let value = NotificationReads.sequence(sequence ?? ""),
        let number = UInt64(value), number < UInt64.max, let api {
        do {
          // Legacy pushes carry a sequence instead of an ID. Resolve that row
          // directly, even when hundreds of newer messages now follow it.
          let page = try await api.get(
            "/api/v0/channels/\(API.segment(channelID))/history", as: History.self,
            query: ["before": String(number + 1), "limit": "1"])
          guard epoch == generation, navigationGeneration == opening, !Task.isCancelled,
            historyOpenings[channelID] == request else { return }
          guard page.channelId == channelID,
            let target = page.messages.first(where: { $0.sequence == value }) else {
            throw APIError("This message is no longer available.", status: 404)
          }
          resolvedID = target.id
        } catch {
          if epoch == generation, navigationGeneration == opening, !Task.isCancelled,
            historyOpenings[channelID] == request { handle(error) }
          return
        }
      }
      if let resolvedID {
        guard await loadContext(channelID, messageID: resolvedID, opening: opening,
          historyOpening: request) else { return }
      } else {
        // An alert without a usable message identity still opens the chat.
        guard await loadLatest(channelID, opening: opening, historyOpening: request) else { return }
      }
    }
    guard epoch == generation, navigationGeneration == opening, !Task.isCancelled,
      historyOpenings[channelID] == request else { return }
    let target = messages(channelID).first {
      resolvedID == nil ? $0.sequence == sequence : $0.id == resolvedID
    }
    focusedNotification = target?.id
    focusedMessage = target?.id
    navigation = [channelID]
  }
  func deepLink(_ url: URL) async {
    let parts = url.pathComponents.filter { $0 != "/" }
    guard ["openteam", "openteam-swift"].contains(url.scheme ?? ""), url.host == "chat",
      parts.count == 1, let id = parts.first else { return }
    guard phase == .ready else {
      pendingDeepLink = url
      return
    }
    let message = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first {
      $0.name == "messageId"
    }?.value
    await open(id, messageID: message)
  }
  private func routePendingDeepLink() async {
    guard phase == .ready, let url = pendingDeepLink else { return }
    pendingDeepLink = nil
    await deepLink(url)
  }
  func setSystemDiscoveryEnabled(_ enabled: Bool) {
    guard let record, !testing else { return }
    systemDiscoveryEnabled = enabled
    SystemDiscovery.shared.setEnabled(enabled, session: record, state: savedSnapshot)
  }

  /// Called by OpenIntent and the Siri draft flow. Validate saved identifiers
  /// against the live account before touching navigation or the existing draft.
  func openSystemItem(_ value: String, draft text: String? = nil, attachments: [Asset] = [],
    recordVoiceNote: Bool = false) async throws {
    let opening = UUID()
    systemOpenGeneration = opening
    systemVoiceRequestID = recordVoiceNote ? opening : nil
    defer { if systemVoiceRequestID == opening { systemVoiceRequestID = nil } }
    // A saved Bot already identifies a locally known destination. Bring up its
    // cached chat without waiting for bootstrap; normal foreground sync updates
    // it independently. Drafting and message lookup keep their live validation.
    if text == nil, attachments.isEmpty,
      try await openCachedBot(value, recordVoiceNote: recordVoiceNote, requestID: opening) { return }
    let client = try await SystemIntentClient.connect()
    guard opening == systemOpenGeneration else { throw CancellationError() }
    guard let id = SystemEntityID(value), id.scope == client.scope,
      [.bot, .conversation, .message].contains(id.kind) else {
      throw APIError("This item belongs to a different OpenTeam account. Choose it again.")
    }
    let target = try client.destination(value, kind: id.kind)
    if recordVoiceNote {
      guard id.kind == .bot else { throw APIError("Choose a Bot to record a voice note.") }
      guard client.bootstrap.runtime["transcription"].string == "configured" else {
        throw APIError("Configure voice notes in OpenTeam Settings before recording.")
      }
    }
    if phase == .starting {
      pendingSystemItem = (value, text, attachments, recordVoiceNote, .now, opening)
      return
    }
    guard phase == .ready, systemScope == client.scope else {
      throw APIError("Connect to this OpenTeam account before opening its content.")
    }
    if id.kind == .bot, text == nil {
      guard try botVoiceLaunch.canOpen(target.id) else { return }
    }
    // Refresh the directory so a newly created Bot can be opened immediately.
    apply(client.bootstrap)
    if let text {
      var existing = draft(target.id)
      guard existing.attachments.count + (existing.stagedFiles?.count ?? 0) + attachments.count <= Draft.maxAttachments else {
        throw APIError("This conversation’s draft already has attachments. Send or clear it first.")
      }
      if !text.isEmpty { existing.text += (existing.text.isEmpty ? "" : "\n") + text }
      existing.attachments += attachments
      saveDraft(existing, channel: target.id)
    }
    await open(target.id, messageID: id.kind == .message ? id.localID : nil)
    guard opening == systemOpenGeneration else { throw CancellationError() }
    if id.kind == .bot, text == nil {
      botVoiceLaunch.open(scope: client.scope, channelID: target.id, record: recordVoiceNote)
    }
    if id.kind == .message, focusedMessage != id.localID {
      throw APIError("This message could not be opened. It may have been removed.")
    }
  }

  private func openCachedBot(_ value: String, recordVoiceNote: Bool, requestID: UUID) async throws -> Bool {
    guard let id = SystemEntityID(value), id.kind == .bot else { return false }
    let session = try SystemIntentClient.savedSession()
    let scope = SystemEntityID.scope(server: session.server, userID: session.userID)
    guard id.scope == scope else {
      throw APIError("This item belongs to a different OpenTeam account. Choose it again.")
    }
    if phase == .starting {
      pendingSystemItem = (value, nil, [], recordVoiceNote, .now, requestID)
      return true
    }
    guard phase == .ready, systemScope == scope,
      record?.server == session.server, record?.userID == session.userID,
      record?.token == session.token else {
      throw APIError("Connect to this OpenTeam account before opening its content.")
    }
    guard let bootstrap = state.bootstrap,
      let target = ShareDirectory.destinations(bootstrap).first(where: {
        $0.id == id.channelID && $0.bot?.id == id.localID && $0.bot?.status != "archived"
      }) else { return false }
    // If configuration is not cached yet, a fresh response may enable voice
    // notes. An already configured composer can begin recording immediately.
    if recordVoiceNote, bootstrap.runtime["transcription"].string != "configured" { return false }
    guard try botVoiceLaunch.canOpen(target.id) else { return true }
    await open(target.id)
    guard requestID == systemOpenGeneration else { throw CancellationError() }
    botVoiceLaunch.open(scope: scope, channelID: target.id, record: recordVoiceNote)
    return true
  }

  /// Leaving the app cancels an unconsumed request, including a live lookup or
  /// a queued cold-start replay. Returning later must not open the microphone.
  func cancelPendingVoiceRecording() {
    if systemVoiceRequestID == systemOpenGeneration { systemOpenGeneration = UUID() }
    if let pending = pendingSystemItem, pending.record {
      if pending.requestID == systemOpenGeneration { systemOpenGeneration = UUID() }
      pendingSystemItem = nil
    }
    botVoiceLaunch.cancelPending()
  }

  func takeBotRecording(for memo: VoiceMemoController, channelID: String,
    key: String, visible: Bool) -> Bool {
    guard visible, botVoiceLaunch.pending != nil else { return false }
    do {
      guard let record else { throw APIError("Connect before recording to a Bot.") }
      try SystemIntentClient.validateSession(record)
    } catch {
      cancelPendingVoiceRecording()
      self.error = UserFacingError.message(error)
      return false
    }
    return botVoiceLaunch.takeRecording(for: memo, scope: systemScope,
      channelID: channelID, key: key, visible: visible)
  }

  private func clearSystemContent() {
    systemOpenGeneration = UUID()
    systemVoiceRequestID = nil
    botVoiceLaunch.reset()
    SystemDiscovery.shared.clear(removeTransfers: true)
    systemScope = nil
    systemDiscoveryEnabled = false
    systemDraft = nil
    pendingSystemItem = nil
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
      clearSystemContent()
      #if canImport(UIKit)
        NativeNotifications.shared.reset()
        ConversationDonation.forgetAll()
      #endif
      lifecycle?.cancel()
      generation = UUID()
      reactionMutations.cancelAll()
      activeSendID = nil
      checkingSendID = nil
      stopPersistence()
      var cleanupFailure: String?
      do { try disk?.clear() } catch {
        cleanupFailure =
          "You are signed out, but some cached files could not be removed. Restart the app and try again."
      }
      state = SavedState()
      record = nil
      stateSyncs.removeAll()
      awaitingInitialSync = false
      self.api = nil
      disk = nil
      phase = .signedOut
      navigation = []
      landing = nil
      activeChannel = nil
      online = false
      cancelConnectionCheck()
      connectionUnavailable = false
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
    clearSystemContent()
    lifecycle?.cancel()
    lifecycle = nil
    generation = UUID()
    reactionMutations.cancelAll()
    activeSendID = nil
    checkingSendID = nil
    cancelAuthentication()
    #if canImport(UIKit)
      NativeNotifications.shared.forgetLocally()
    #endif
    stopPersistence()
    phase = .signedOut
    record = nil
    stateSyncs.removeAll()
    awaitingInitialSync = false
    api = nil
    disk = nil
    state = SavedState()
    histories = [:]
    historyLoadFailures.removeAll()
    historyWindows = [:]
    historyOpenings = [:]
    navigation = []
    landing = nil
    activeChannel = nil
    focusedMessage = nil
    focusedRoutine = nil
    pendingDeepLink = nil
    busy = []
    sending = false
    online = false
    cancelConnectionCheck()
    connectionUnavailable = false
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
      if !testing { try SecureSession.clear() }
      var directories = [testDirectory]
      #if canImport(UIKit)
        if !testing {
          // Clear every account's sandbox data.
          directories = [.applicationSupportDirectory, .cachesDirectory, .documentDirectory]
            .flatMap { FileManager.default.urls(for: $0, in: .userDomainMask) }
          directories.append(FileManager.default.temporaryDirectory)
        }
      #endif
      try LocalDataReset.erase(directories: directories)
      #if canImport(UIKit)
        ConversationDonation.forgetAll()
      #endif
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
      clearSystemContent()
      #if canImport(UIKit)
        NativeNotifications.shared.reset()
      #endif
      lifecycle?.cancel()
      cancelConnectionCheck()
      connectionUnavailable = false
      generation = UUID()
      reactionMutations.cancelAll()
      activeSendID = nil
      checkingSendID = nil
      flushPersistence()
      stopPersistence()
      api = nil
      state = SavedState()
      disk = nil
      phase = .signedOut
      stateSyncs.removeAll()
      awaitingInitialSync = false
      navigation = []
      landing = nil
      try? SecureSession.clear()
      validatedServer = server
      authPath = [.endpoint, .credentials]
      // Mid-setup there are no drafts yet; signing in again resumes setup where it was.
      authError =
        onboarding == .showing
        ? "You were signed out. Sign in again to continue."
        : "Your session expired. Sign in again. Your drafts are saved on this iPhone."
      self.error = nil
    } else {
      if error is URLError || ((error as? APIError)?.status ?? 0) >= 500 {
        // A timed-out long poll or a failing endpoint does not establish an
        // outage. Confirm it independently before showing a connection warning.
        confirmConnectionFailure()
        syncUnavailable = true
      } else if error is DecodingError {
        // A reachable server can return data this client cannot decode.
        syncUnavailable = true
      }
      if !quiet { self.error = UserFacingError.message(error) }
    }
  }

  private func cancelConnectionCheck() {
    connectionCheck?.cancel()
    connectionCheck = nil
    connectionCheckID = nil
  }

  private func recordReachable(epoch: UUID) {
    guard epoch == generation, phase == .ready, !Task.isCancelled else { return }
    cancelConnectionCheck()
    online = true
    connectionUnavailable = false
  }

  func retryConnection() {
    confirmConnectionFailure(immediately: true)
  }

  private func confirmConnectionFailure(immediately: Bool = false) {
    if immediately { cancelConnectionCheck() }
    guard connectionCheck == nil, phase == .ready, foreground, let api else { return }
    let epoch = generation
    let checkID = UUID()
    // A new warning requires sustained failure. Once an outage is already
    // visible, a user retry only needs one bounded check to recover promptly.
    let attempts = connectionUnavailable ? 1 : 3
    connectionCheckID = checkID
    connectionCheck = Task { [weak self] in
      defer {
        if let self, self.connectionCheckID == checkID {
          self.connectionCheck = nil
          self.connectionCheckID = nil
        }
      }
      // Let short transitions recover without flashing a warning. Successful
      // requests cancel this check, including an in-flight probe's stale result.
      if !immediately {
        do { try await Task.sleep(for: .seconds(1)) } catch { return }
      }
      var reachable = false
      for attempt in 0..<attempts {
        if attempt > 0 {
          do { try await Task.sleep(for: .seconds(1)) } catch { return }
        }
        guard !Task.isCancelled, self?.generation == epoch,
          self?.connectionCheckID == checkID, self?.foreground == true
        else { return }
        do {
          // An ordinary API observer would cancel this task on its own success.
          let probe = try API(server: api.baseURL.absoluteString, token: api.token)
          _ = try await probe.raw("/api/auth/config", timeout: 5)
          reachable = true
        } catch {
          guard !UserFacingError.isCancelled(error) else { return }
          if let response = error as? APIError, (100..<500).contains(response.status) {
            reachable = true
          } else if !(error is URLError) && ((error as? APIError)?.status ?? 0) < 500 {
            return
          }
        }
        if reachable { break }
      }
      guard let self, !Task.isCancelled, self.generation == epoch,
        self.connectionCheckID == checkID, self.phase == .ready, self.foreground
      else { return }
      self.connectionCheck = nil
      self.connectionCheckID = nil
      if reachable {
        self.recordReachable(epoch: epoch)
        // A user retry bypasses the poll's backoff and reconciles fresh state.
        if immediately { self.startEvents() }
      } else {
        self.online = false
        self.connectionUnavailable = true
        self.syncUnavailable = true
      }
    }
  }
}

private enum SendPollingError: Error { case awaitingDelivery, deadlineReached }

/// Shared with URLSession's delegate queue. Only increasing bytes per staged file
/// refresh the stall deadline, so retrying the same upload prefix cannot keep it alive.
private final class SendProgressBudget: @unchecked Sendable {
  private let lock = NSLock()
  private let clock = ContinuousClock()
  private let stall: Duration
  private let overallDeadline: ContinuousClock.Instant
  private var lastProgress: ContinuousClock.Instant
  private var uploaded: [String: Int64] = [:]
  init(stall: Duration, overall: Duration) {
    self.stall = stall
    self.lastProgress = clock.now
    self.overallDeadline = clock.now.advanced(by: overall)
  }
  var remaining: Duration {
    lock.withLock {
      clock.now.duration(to: min(overallDeadline, lastProgress.advanced(by: stall)))
    }
  }
  func check() throws {
    guard remaining > .zero else { throw SendPollingError.deadlineReached }
  }
  func overallRemaining() throws -> TimeInterval {
    try check()
    let parts = clock.now.duration(to: overallDeadline).components
    return max(0.001, Double(parts.seconds) + Double(parts.attoseconds) / 1e18)
  }
  func progress() {
    lock.withLock {
      // A late callback cannot resurrect an already stalled attempt.
      if clock.now < lastProgress.advanced(by: stall) { lastProgress = clock.now }
    }
  }
  func uploadProgress(file: String, bytes: Int64) {
    lock.withLock {
      guard bytes > (uploaded[file] ?? 0) else { return }
      uploaded[file] = bytes
      if clock.now < lastProgress.advanced(by: stall) { lastProgress = clock.now }
    }
  }
}
