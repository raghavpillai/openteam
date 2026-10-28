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
  private var pendingSystemItem: (id: String, draft: String?, attachments: [Asset], record: Bool, createdAt: Date)?
  private var systemOpenGeneration = UUID()
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
  private var drafts: [String: Draft] = [:]
  private var persistenceTask: Task<Void, Never>?
  private var writer: StateWriter?
  var error: String?
  var online = false
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
    didSet { botVoiceLaunch.cancelPending(unless: navigation.last) }
  }
  var focusedRoutine: String?
  var focusedMessage: String?
  var activeChannel: String?
  var histories: [String: History] = [:]
  private(set) var historyLoadFailures: Set<String> = []
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
  private var backgroundHistories: Task<Void, Never>?
  private var backgroundHistoryQueue: [String] = []
  /// Newest message sequence each chat's notifications announced. A push can
  /// arrive, or be tapped, before the next bootstrap knows about its message.
  private var notifiedLatest: [String: String] = [:]
  private var needsIdentityRefresh = false
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
  func isHidden(_ channel: Channel) -> Bool {
    bot(for: channel)?.hiddenFromSidebar ?? channel.hiddenFromSidebar ?? false
  }
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
    if let url = pendingDeepLink {
      pendingDeepLink = nil
      await deepLink(url)
    }
  }
  private func activate(
    _ next: SessionRecord, persistSession: Bool = false, requestPushPermission: Bool = true
  ) throws {
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
    stopBackgroundHistories()
    notifiedLatest = [:]
    needsIdentityRefresh = false
    stateSyncs.removeAll()
    awaitingInitialSync = !launchComplete
    syncUnavailable = false
    generation = UUID()
    navigation = []
    landing = nil
    activeChannel = nil
    histories = [:]
    historyLoadFailures.removeAll()
    historyWindows = [:]
    if let systemScope, systemScope != scope {
      systemDraft = nil; pendingSystemItem = nil
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
    drafts = nextState.drafts
    onboarding =
      UserDefaults.standard.bool(forKey: OnboardingDecision.key(server: next.server))
        && !onboardingForcedForQA ? .hidden : .undecided
    phase = .ready
    if systemDiscoveryEnabled { SystemDiscovery.shared.update(session: next, state: nextState) }
    if let pending = pendingSystemItem {
      pendingSystemItem = nil
      Task {
        do {
          guard !pending.record || Date.now.timeIntervalSince(pending.createdAt) < 30 else {
            throw APIError("Run the voice-note shortcut again to start recording.")
          }
          try await openSystemItem(pending.id, draft: pending.draft,
            attachments: pending.attachments, recordVoiceNote: pending.record)
        }
        catch { self.error = UserFacingError.message(error) }
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
    decideOnboarding()
    if !testing, directoryChanged { TeamAppShortcuts.updateAppShortcutParameters() }
    for (channel, messages) in Dictionary(grouping: bootstrap.latestMessages, by: \.channelId) {
      // Bootstrap carries only each channel's newest message. A loaded
      // transcript takes new messages from its next history page instead, so
      // earlier ones never appear above a newer one already on screen.
      // Previews read it through latestMessage(_:).
      if hasCachedHistory(channel) {
        let known = Set(self.messages(channel).map(\.id))
        let updates = messages.filter { known.contains($0.id) }
        if !updates.isEmpty { merge(updates, channel: channel) }
      } else {
        merge(messages, channel: channel)
      }
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
  private func beginStateSync() -> UUID {
    if stateSyncs.isEmpty { syncUnavailable = false }
    let id = UUID()
    stateSyncs.insert(id)
    return id
  }
  func refresh(quiet: Bool = false, flushPending: Bool = true) async {
    guard let api, phase == .ready else { return }
    let epoch = generation
    let sync = beginStateSync()
    defer { stateSyncs.remove(sync) }
    do {
      let bootstrap = try await api.get("/api/v0/client-bootstrap", as: Bootstrap.self)
      guard epoch == generation, !Task.isCancelled else { return }
      apply(bootstrap)
      online = true
      syncUnavailable = false
      persist()
      let root = try await api.request("/api/v0/settings")
      guard epoch == generation else { return }
      if root["settings"]["sidebarPreferences"]["version"].int == 2 {
        sidebar = root["settings"]["sidebarPreferences"]
      }
      // Pending sends are separate from loading the main screen's state.
      stateSyncs.remove(sync)
      if flushPending { await flush() }
    } catch { if epoch == generation { handle(error, quiet: quiet) } }
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
      await refreshSession(epoch: epoch, sync: sync)
      guard epoch == generation, !Task.isCancelled, phase == .ready else { return }
      await flush()
      guard epoch == generation, !Task.isCancelled, phase == .ready else { return }
      if let activeChannel { await loadHistory(activeChannel) }
      syncBackgroundHistories(epoch: epoch)
      var cursor = state.bootstrap?.cursor ?? "0"
      var delay: UInt64 = 1
      while !Task.isCancelled, epoch == generation, phase == .ready, let api {
        do {
          let batch = try await api.get(
            "/api/v0/events/poll", as: EventBatch.self, query: ["after": cursor, "waitMs": "25000"])
          try Task.checkCancellation()
          guard epoch == generation else { return }
          let reconnectSync = online ? nil : beginStateSync()
          defer { if let reconnectSync { stateSyncs.remove(reconnectSync) } }
          delay = 1
          if reconnectSync != nil || !batch.events.isEmpty {
            // Reconcile authoritative bounded projections. Advance the cursor only after reconciliation succeeds.
            let bootstrap = try await api.get("/api/v0/client-bootstrap", as: Bootstrap.self)
            try Task.checkCancellation()
            guard epoch == generation else { return }
            apply(bootstrap)
            if reconnectSync != nil {
              let root = try await api.request("/api/v0/settings")
              try Task.checkCancellation()
              guard epoch == generation else { return }
              if root["settings"]["sidebarPreferences"]["version"].int == 2 {
                sidebar = root["settings"]["sidebarPreferences"]
              }
            }
            if let activeChannel {
              try await fetchHistory(activeChannel, before: nil, api: api, epoch: epoch)
            }
            syncBackgroundHistories(epoch: epoch)
            cursor = bootstrap.cursor
            persist()
          }
          online = true
          syncUnavailable = false
          if let reconnectSync { stateSyncs.remove(reconnectSync) }
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
  private func refreshSession(epoch: UUID, sync: UUID) async {
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
        guard epoch == generation, !Task.isCancelled else { return }
        record = updated
        userName = updated.displayName
        needsIdentityRefresh = false
      } catch {
        guard epoch == generation, !Task.isCancelled else { return }
        handle(APIError("Your session expired. Sign in again.", status: 401))
        return
      }
    }
    await refresh(quiet: true, flushPending: false)
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
      let channel = channel(id), channel.hiddenFromSidebar != true
    else { return false }
    guard hasCachedHistory(id) else {
      return (channel.unreadCount ?? 0) > 0
        && state.bootstrap?.latestMessages.contains(where: { $0.channelId == id }) == true
    }
    return transcriptBehind(id)
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
      if epoch == generation, !Task.isCancelled,
        !(error is CancellationError), (error as? URLError)?.code != .cancelled
      {
        if !older { historyLoadFailures.insert(id) }
        // Initial-load errors are rendered in the chat when no saved content is
        // available. Cached transcripts stay readable; pagination still reports
        // its error without replacing the transcript.
        handle(error, quiet: !older)
      }
    }
  }
  private func fetchHistory(_ id: String, before: String?, api: API, epoch: UUID) async throws {
    var query = ["limit": "60"]
    if let before { query["before"] = before }
    let page = try await api.get(
      "/api/v0/channels/\(API.segment(id))/history", as: History.self, query: query)
    guard epoch == generation, !Task.isCancelled else { return }
    historyLoadFailures.remove(id)
    // The latest page is authoritative for what a notification announced.
    if before == nil { notifiedLatest[id] = nil }
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
    state.loadedHistoryChannels = (state.loadedHistoryChannels ?? []).union([page.channelId])
    histories[page.channelId] = page
    historyWindows[page.channelId] = HistoryWindow(
      messages: page.messages, hasEarlier: page.hasMore, hasLater: false)
    state.messages[page.channelId] = MessageMerge.merge(page.threadContext, page.messages)
  }
  @discardableResult
  func loadContext(_ channelID: String, messageID: String, preservingTimeline: Bool = false) async -> Bool {
    guard let api else { return false }
    let epoch = generation
    do {
      let page = try await api.get(
        "/api/v0/channel-messages/\(API.segment(messageID))/context", as: MessageContext.self)
      guard epoch == generation else { return false }
      guard page.channelId == channelID else {
        throw APIError("This message belongs to another conversation.")
      }
      if preservingTimeline {
        state.messages[channelID] = MessageMerge.merge(messages(channelID), page.threadContext + page.messages)
        persist()
        return true
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
        #if canImport(UIKit)
          let donatedBot = bot(for: channel)
          Task {
            let image = await ConversationDonation.avatar(channel: channel, bot: donatedBot, api: api)
            ConversationDonation.donateSent(channel: channel, bot: donatedBot, image: image)
          }
        #endif
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
      pendingSystemItem = (value, text, attachments, recordVoiceNote, .now)
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
      guard existing.attachments.count + (existing.stagedFiles?.count ?? 0) + attachments.count <= 6 else {
        throw APIError("This conversation’s draft already has attachments. Send or clear it first.")
      }
      if !text.isEmpty { existing.text += (existing.text.isEmpty ? "" : "\n") + text }
      existing.attachments += attachments
      saveDraft(existing, channel: target.id)
    }
    await open(target.id, messageID: id.kind == .message ? id.localID : nil)
    if id.kind == .bot, text == nil {
      botVoiceLaunch.open(scope: client.scope, channelID: target.id, record: recordVoiceNote)
    }
    if id.kind == .message, focusedMessage != id.localID {
      throw APIError("This message could not be opened. It may have been removed.")
    }
  }

  private func clearSystemContent() {
    systemOpenGeneration = UUID()
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
    navigation = []
    landing = nil
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
      generation = UUID()
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
      if !(error is APIError) || ((error as? APIError)?.status ?? 0) >= 500 {
        online = false
        syncUnavailable = true
      }
      if !quiet { self.error = UserFacingError.message(error) }
    }
  }
}
