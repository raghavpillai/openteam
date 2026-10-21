import Observation
import SwiftUI

/// Connects a model provider, chooses a model, and proves it works with one real
/// request. Shared by onboarding and Settings → Model; mirrors desktop's useModelSetup.
@MainActor @Observable final class ModelSetup {
  enum Busy: Equatable { case load, provider, connect, respond, disconnect, save }
  /// A browser sign-in shown in the app, which ends on a localhost page.
  struct WebSignIn: Identifiable, Equatable {
    let sessionId: String
    let promptId: String
    let url: URL
    let redirect: URL
    var id: String { sessionId + promptId }
  }
  private(set) var data: ServerSettings?
  private(set) var choice = ModelChoice(providerId: "", modelId: "", reasoning: "medium")
  private(set) var session: InferenceAuthSession?
  private(set) var busy: Busy? = .load
  var error: String?
  private(set) var test: ModelTestState = .idle
  /// Presented as a sheet. Closing it leaves the browser and paste fallbacks.
  var webSignIn: WebSignIn?
  /// Onboarding saves and tests the provider's default model as soon as a sign-in connects.
  var applyWhenConnected = false
  private var answeredPrompts: Set<String> = []
  /// An API key typed in onboarding, held only until the sign-in asks for it.
  private var pendingKey: String?
  private var presentedWebSessions: Set<String> = []
  private var poller: Task<Void, Never>?
  /// The error on screen came from polling, so the next successful poll clears it.
  private var pollFailed = false
  private let store: AppStore

  init(store: AppStore) { self.store = store }

  var provider: InferenceProvider? { data?.provider(choice.providerId) }
  var providerId: String { choice.providerId }
  var modelId: String { choice.modelId }
  var selectedModel: InferenceModel? { data?.models.first { $0.modelId == choice.modelId } }
  var reasoningLevels: [String] { selectedModel?.reasoningLevels ?? [] }
  var effectiveReasoning: String { choice.effectiveReasoning(selectedModel) }
  var changed: Bool {
    data.map { choice.changed(from: $0.inference, model: selectedModel) } ?? false
  }
  var signingIn: Bool { session != nil }

  /// Loads the settings once. A blip is tried again quietly; anything else is shown
  /// as a sentence, and calling this again retries.
  func start() async {
    guard data == nil else { return }
    busy = .load
    error = nil
    var retried = false
    while true {
      do { try await load() } catch {
        guard !UserFacingError.isCancelled(error) else { break }
        let failure = ModelTestFailure(request: error)
        if failure.transient, !retried {
          retried = true
          try? await Task.sleep(for: .milliseconds(1500))
          if !Task.isCancelled { continue }
        }
        self.error = failure.message
      }
      break
    }
    busy = nil
  }

  @discardableResult private func load(_ requested: String? = nil) async throws -> ServerSettings {
    let next = try await store.request(
      InferenceRequest.settingsPath, query: requested.map { ["provider": $0] } ?? [:]
    ).decode(ServerSettings.self)
    data = next
    choice = ModelChoice(loading: next, provider: requested)
    return next
  }

  /// Loads a provider's connection and models. `reload` fetches them again even
  /// when it's already selected, for example to see a sign-in finished elsewhere.
  func selectProvider(_ id: String, reload: Bool = false) async {
    if id == choice.providerId, data != nil, !reload { return }
    cancelSignIn()
    error = nil
    test = .idle
    choice.providerId = id
    busy = .provider
    do { try await load(id) } catch { failed(error, "Could not load this provider's models") }
    busy = nil
  }

  func selectModel(_ id: String) {
    guard let model = data?.models.first(where: { $0.modelId == id }) else { return }
    choice.select(model: model)
    test = .idle
  }

  func setReasoning(_ level: String) {
    choice.reasoning = level
    test = .idle
  }

  func connect(_ authType: String? = nil) async {
    guard let provider, let type = authType ?? provider.authMethods.first?.type else { return }
    webSignIn = nil
    busy = .connect
    error = nil
    test = .idle
    do {
      let next = try await store.request(
        InferenceRequest.startPath(provider.id), method: "POST",
        body: InferenceRequest.start(authType: type), timeout: 30
      ).decode(InferenceAuthSession.self)
      poller?.cancel()
      poller = nil
      session = nil
      update(next)
    } catch { failed(error, "Could not start the sign-in") }
    busy = nil
  }

  /// Starts an API-key sign-in and answers its key prompt with `key`.
  func connect(apiKey key: String) async {
    pendingKey = key
    await connect("api_key")
    if session == nil { pendingKey = nil }
  }

  /// Fetches the current provider's connection and models again.
  func reload() async {
    guard !choice.providerId.isEmpty else { return }
    do { try await load(choice.providerId) } catch {
      failed(error, "Could not load this provider's models")
    }
  }

  /// Checks a waiting sign-in right away, for example when the app returns from Safari.
  func pollNow() {
    guard let session, !session.finished else { return }
    poller?.cancel()
    poller = nil
    if pollFailed {
      pollFailed = false
      error = nil
    }
    watch(session.id, immediately: true)
  }

  /// The person answered the sign-in's last question (or the in-app browser did),
  /// and the server is finishing the connection.
  var finishingSignIn: Bool {
    guard let session, !session.finished, session.prompt == nil, session.deviceCode == nil
    else { return false }
    return finishingSession == session.id
  }
  private var finishingSession: String?

  /// `automatic` answers are the app's own (such as choosing a device code).
  func respond(_ promptId: String, _ value: String, automatic: Bool = false) async {
    guard let current = session, !value.isEmpty else { return }
    busy = .respond
    error = nil
    do {
      let next = try await store.request(
        InferenceRequest.respondPath(current.id), method: "POST",
        body: InferenceRequest.respond(promptId: promptId, value: value), timeout: 60
      ).decode(InferenceAuthSession.self)
      if !automatic { finishingSession = next.id }
      if session?.id == next.id { update(next) }
    } catch { failed(error, "Could not continue the sign-in") }
    busy = nil
  }

  /// Stops a sign-in in progress on the server too, so a new one can start.
  func cancelSignIn() {
    poller?.cancel()
    poller = nil
    webSignIn = nil
    pendingKey = nil
    if let session, !session.finished {
      let path = InferenceRequest.sessionPath(session.id)
      Task { [store] in _ = try? await store.request(path, method: "DELETE") }
    }
    session = nil
  }

  /// After a failed or cancelled sign-in, back to the provider's buttons.
  func clearSignIn() {
    poller?.cancel()
    poller = nil
    webSignIn = nil
    pendingKey = nil
    session = nil
  }

  /// Reopens the in-app browser for the current sign-in.
  func openWebSignIn() {
    guard let session, let redirect = session.capturableRedirect,
      let prompt = session.prompt,
      let url = session.authorizationUrl.flatMap(URL.init(string:))
    else { return }
    webSignIn = WebSignIn(sessionId: session.id, promptId: prompt.id, url: url, redirect: redirect)
  }

  /// The in-app browser reached the localhost redirect; hand its address to the server.
  func captured(_ callback: URL, for signIn: WebSignIn) async {
    webSignIn = nil
    guard session?.id == signIn.sessionId, session?.prompt?.id == signIn.promptId else { return }
    NativeHaptics.play(.light, source: "model.sign-in")
    await respond(signIn.promptId, callback.absoluteString)
  }

  func disconnect() async {
    guard let provider else { return }
    busy = .disconnect
    error = nil
    test = .idle
    do {
      _ = try await store.request(InferenceRequest.providerPath(provider.id), method: "DELETE")
      clearSignIn()
      try await load(provider.id)
      await store.refreshRuntime()
    } catch { failed(error, "Could not disconnect this provider") }
    busy = nil
  }

  /// Why the last test failed, for wording that depends on it (a rejected key).
  private(set) var testFailure: ModelTestFailure?

  /// Sends one tiny real request to the saved model, or to `candidate` without saving
  /// it. A quick failure that looks like a blip (a dropped connection, a busy or
  /// restarting server, a provider's 503) is tried once more before it's shown; slow
  /// ones and real problems show at once.
  @discardableResult func runTest(_ candidate: InferenceSelection? = nil) async -> Bool {
    test = .running
    testFailure = nil
    // No body tests the saved model.
    let body = candidate.flatMap { try? JSON.encode($0) }
    var retried = false
    while true {
      let started = ContinuousClock.now
      let failure: ModelTestFailure
      do {
        let result = try await store.request(
          InferenceRequest.testPath, method: "POST", body: body, timeout: 90
        ).decode(InferenceTestResult.self)
        switch result {
        case .passed(let latency):
          test = .passed(latencyMs: latency)
          NativeHaptics.play(.success, source: "model.test")
          return true
        case .failed(let raw):
          failure = ModelTestFailure(provider: raw)
        }
      } catch {
        guard !UserFacingError.isCancelled(error) else {
          test = .idle
          return false
        }
        failure = ModelTestFailure(request: error)
      }
      if failure.transient, !retried, ContinuousClock.now - started < .seconds(10) {
        retried = true
        try? await Task.sleep(for: .milliseconds(1500))
        if !Task.isCancelled { continue }
      }
      guard !Task.isCancelled else {
        test = .idle
        return false
      }
      test = .failed(failure.message)
      testFailure = failure
      NativeHaptics.play(.error, source: "model.test")
      return false
    }
  }

  /// Connects an API key and proves it before anything is saved: the sign-in has to
  /// finish, the provider has to list its models for the key, and one real request to
  /// the model it would use has to work. Returns nil once the key is connected, tested
  /// and saved; otherwise the reason, in plain words, for the key step.
  func connectKey(_ key: String, provider id: String, name: String) async -> String? {
    await selectProvider(id, reload: true)
    if let failure = error {
      error = nil
      return failure
    }
    await connect(apiKey: key)
    while let session, !session.finished, error == nil, !Task.isCancelled {
      try? await Task.sleep(for: .milliseconds(150))
    }
    if let failure = error {
      error = nil
      clearSignIn()
      return failure
    }
    guard session?.status == "connected" else {
      let reason =
        session?.error.map { ModelTestFailure(provider: $0).keyMessage(provider: name) }
        ?? "\(name) didn't accept that key. Check it and try again."
      clearSignIn()
      return reason
    }
    // The key is stored on the server now; the provider proves it by listing models.
    do { try await load(id) } catch {
      return ModelTestFailure(request: error).message
    }
    guard let data, !data.models.isEmpty, !choice.modelId.isEmpty else {
      let failure = ModelTestFailure(
        provider: provider?.modelMessage ?? "\(name) didn't list any chat models for this key.")
      if failure.rejected { await forget(id) }
      return failure.keyMessage(provider: name)
    }
    // One real request to the recommended model, still without saving it.
    guard await runTest(choice.body(model: selectedModel)) else {
      let failure = testFailure ?? ModelTestFailure(provider: "")
      if failure.rejected { await forget(id) }
      return failure.keyMessage(provider: name)
    }
    busy = .save
    defer { busy = nil }
    do {
      _ = try await store.request(
        InferenceRequest.inferencePath, method: "PATCH",
        body: try JSON.encode(choice.body(model: selectedModel)), timeout: 90)
      try await load(id)
      await store.refreshRuntime()
    } catch {
      return UserFacingError.isCancelled(error)
        ? "Could not save the model" : message(error, "Could not save the model")
    }
    return nil
  }

  /// Removes a key the provider turned down, so it isn't left connected.
  private func forget(_ id: String) async {
    _ = try? await store.request(InferenceRequest.providerPath(id), method: "DELETE")
    _ = try? await load(id)
  }

  /// Saves the selection, then sends one real request so problems show up now.
  @discardableResult func apply() async -> Bool {
    guard !choice.providerId.isEmpty, !choice.modelId.isEmpty else { return false }
    busy = .save
    error = nil
    do {
      _ = try await store.request(
        InferenceRequest.inferencePath, method: "PATCH",
        body: try JSON.encode(choice.body(model: selectedModel)), timeout: 90)
      try await load(choice.providerId)
      await store.refreshRuntime()
    } catch {
      failed(error, "Could not save the model")
      busy = nil
      return false
    }
    let passed = await runTest()
    busy = nil
    await store.refreshRuntime()
    return passed
  }

  /// Leaving the screen ends a sign-in still waiting for the person.
  func stop() { cancelSignIn() }

  // MARK: - Sign-in progress

  private func update(_ next: InferenceAuthSession) {
    session = next
    // Take the steps a person would otherwise do by hand.
    if let answer = next.automaticAnswer, !answeredPrompts.contains(answer.promptId) {
      answeredPrompts.insert(answer.promptId)
      Task { await respond(answer.promptId, answer.value, automatic: true) }
    }
    if let key = pendingKey, let prompt = next.prompt, prompt.type == "secret", !next.finished,
      !answeredPrompts.contains(prompt.id)
    {
      answeredPrompts.insert(prompt.id)
      pendingKey = nil
      Task { await respond(prompt.id, key) }
    }
    if next.capturableRedirect != nil, let prompt = next.prompt,
      !presentedWebSessions.contains(next.id + prompt.id)
    {
      presentedWebSessions.insert(next.id + prompt.id)
      openWebSignIn()
    }
    if next.finished {
      poller?.cancel()
      poller = nil
      webSignIn = nil
      pendingKey = nil
      if next.status == "connected" {
        NativeHaptics.play(.success, source: "model.sign-in")
        Task {
          do {
            try await load(next.providerId)
          } catch {
            failed(error, "Could not load this provider's models")
            return
          }
          if applyWhenConnected, choice.providerId == next.providerId, !choice.modelId.isEmpty,
            provider?.connected == true
          {
            applyWhenConnected = false
            await apply()
          }
        }
      } else if next.status == "failed" {
        NativeHaptics.play(.error, source: "model.sign-in")
      }
    } else if poller == nil {
      watch(next.id)
    }
  }

  private func watch(_ id: String, immediately: Bool = false) {
    poller = Task { [weak self] in
      var failures = 0
      var first = immediately
      while !Task.isCancelled {
        if !first { try? await Task.sleep(for: .seconds(1)) }
        first = false
        guard let self, !Task.isCancelled, self.session?.id == id else { return }
        do {
          let next = try await self.store.request(InferenceRequest.sessionPath(id))
            .decode(InferenceAuthSession.self)
          guard !Task.isCancelled, self.session?.id == id else { return }
          failures = 0
          if self.pollFailed {
            self.pollFailed = false
            self.error = nil
          }
          if next.finished { self.poller = nil }
          self.update(next)
          if next.finished { return }
        } catch {
          guard !Task.isCancelled, !UserFacingError.isCancelled(error) else { return }
          // A moment offline (for example while signing in in Safari) is not a failure.
          failures += 1
          if failures >= 3 {
            self.failed(error, "Could not check the sign-in")
            self.pollFailed = true
          }
        }
      }
    }
  }

  private func failed(_ error: Error, _ fallback: String) {
    guard !UserFacingError.isCancelled(error) else { return }
    self.error = message(error, fallback)
  }
  private func message(_ error: Error, _ fallback: String) -> String {
    let text = UserFacingError.message(error).trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? fallback : text
  }
}
