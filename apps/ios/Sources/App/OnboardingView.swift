import SwiftUI

/// First-run setup after sign-in, one decision per screen: check the server (W3),
/// choose and test the bots' AI (W4–W5), voice notes (W6), and the first bot (W7).
/// Once the bot is created, Home shows it arriving and zooms into its chat (W8). Same
/// screens and copy as desktop; the art lives in the shared WizardBackdrop.
struct OnboardingView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var setup: ModelSetup?
  /// The page comes in just after the sign-in page has dissolved, so their text never
  /// overlaps; the art behind both carries on throughout.
  @State private var entered = false
  var body: some View {
    Group {
      if let setup {
        OnboardingWizard(setup: setup)
      } else {
        // The wizard's backdrop shows through until the first page is ready.
        Color.clear
      }
    }
    .opacity(entered || reduceMotion ? 1 : 0)
    .task {
      if setup == nil { setup = ModelSetup(store: store) }
      withAnimation(.smooth(duration: 0.45).delay(0.16)) { entered = true }
    }
  }
}

/// The steps as a NavigationStack: each pushes like an iOS screen, with the system
/// back button and edge swipe. The server check is the root; once it passes, the
/// model choice hides Back so the check isn't revisited, and a finished sign-in is
/// replaced by the test so Back from the test returns to the choice.
private struct OnboardingWizard: View {
  @Environment(AppStore.self) private var store
  @Environment(\.openURL) private var openURL
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(WizardBackdrop.self) private var backdrop: WizardBackdrop?
  @Bindable var setup: ModelSetup

  @State private var path: [WizardStep] = []
  // W3
  @State private var ticked = 0
  @State private var healthy = false
  @State private var stalled = false
  @State private var checking = false
  // W4
  @State private var choosing: String?
  @State private var savedChecked = false
  @State private var changingModel = false
  // W4: ChatGPT or Claude, by plan or by key
  @State private var family = ProviderFamilies.chatgpt
  // W4a
  @State private var copiedCode: String?
  @State private var pasted = ""
  // W4b
  @State private var apiKey = ""
  /// The provider the key is for: OpenAI, Anthropic, OpenRouter or one from "More providers".
  @State private var keyProvider = "openai"
  @State private var keyError: String?
  @State private var connectingKey = false
  @State private var keyAccepted = false
  /// The OpenAI key from W4b, offered again for voice notes. Kept only in memory.
  @State private var openAIKey: String?
  // W5
  @State private var modelProblem: String?
  @State private var celebrate = 0
  /// A key is tested before W5 opens; the confetti waits for the page.
  @State private var celebrateOnArrival = false
  @State private var choosingModel = false
  // W6
  @State private var voice: TranscriptionSettingsView?
  @State private var voiceProvider: TranscriptionSettings.Provider = .openai
  @State private var voiceKey = ""
  @State private var voiceBusy = false
  @State private var voiceError: String?
  @State private var voiceOn = false
  // W7
  @State private var botName = FirstBot.randomName()
  @State private var avatar = FirstBot.randomAvatar()
  @State private var role = FirstBot.roles[0]
  @State private var shuffles = 0
  @State private var creating = false
  @State private var createError: String?
  @State private var requestID = UUID().uuidString
  /// Bots on the server when setup opened. One that turns up later came from a Create
  /// here whose answer was lost, or from another device finishing setup.
  @State private var botsAtStart: Set<String>?
  /// What each Create from here asked for, to tell those two apart.
  @State private var sentBots: Set<FirstBot.Request> = []
  /// Bots from another device the person left, to create their own too.
  @State private var setAsideBots: Set<String> = []
  /// Mirrored into each page's own focus (see WizardFocusHost).
  @State private var focus: Focus?
  private enum Focus: Hashable { case apiKey, voiceKey, botName, paste }
  private typealias FocusBinding = FocusState<Focus?>.Binding

  /// The screen on top.
  private var step: WizardStep { path.last ?? .health }
  private var voiceConfigured: Bool {
    voice?.configured ?? (store.runtime.values["transcription"] == "configured")
  }
  private var testPassed: Bool {
    if case .passed = setup.test { return true }
    return false
  }
  /// "It works!" turns the chat card dark, like a finish line.
  private var payoff: Bool { modelProblem == nil && testPassed }

  var body: some View {
    NavigationStack(path: $path) {
      page(.health)
        .navigationDestination(for: WizardStep.self) { page($0) }
    }
    .sheet(item: $setup.webSignIn) { signIn in
      ProviderWebSignInSheet(signIn: signIn) { url in
        Task { await setup.captured(url, for: signIn) }
      }
    }
    .sheet(isPresented: $choosingModel) {
      ModelSearchSheet(
        models: setup.data?.models ?? [], selected: setup.modelId,
        recommended: setup.data?.recommendedModel?.modelId
      ) { id in changeModel(id) }
    }
    .task {
      if botsAtStart == nil { botsAtStart = Set(store.bots.map(\.id)) }
      await setup.start()
      if voice == nil {
        voice = try? await store.request(TranscriptionRequest.path)
          .decode(TranscriptionSettingsView.self)
      }
    }
    .onChange(of: scenePhase) { _, phase in
      // Back from Safari or another app: check what this screen is waiting for now.
      guard phase == .active else { return }
      switch step {
      case .health: Task { await store.refreshRuntime() }
      case .signIn, .apiKey: setup.pollNow()
      default: break
      }
    }
    .onChange(of: path) { before, after in
      focus = nil
      // Back from a sign-in in progress stops it on the server too.
      if after.count < before.count, let left = before.last, [.signIn, .apiKey].contains(left) {
        setup.cancelSignIn()
      }
    }
    .onChange(of: setup.session?.deviceCode?.userCode) { _, code in
      // The code is on the clipboard before Safari opens, ready to paste.
      guard let code, step == .signIn else { return }
      UIPasteboard.general.string = code
      copiedCode = code
    }
    .onChange(of: scene, initial: true) { _, scene in
      guard store.onboarding == .showing else { return }
      backdrop?.show(scene, stage: step.stage, reduceMotion: reduceMotion)
    }
    .onChange(of: setup.test) { _, test in
      if case .passed = test, step == .test { celebrate += 1 }
    }
    .onChange(of: celebrate) { _, _ in
      // The test's success haptic lands with the check; two taps follow the confetti.
      guard !reduceMotion else { return }
      Task { @MainActor in
        try? await Task.sleep(for: .milliseconds(170))
        NativeHaptics.play(.light, source: "onboarding.it-works")
        try? await Task.sleep(for: .milliseconds(150))
        NativeHaptics.play(.light, source: "onboarding.it-works")
      }
    }
    .onChange(of: setup.session?.prompt?.id) { _, _ in pasted = "" }
    .onChange(of: apiKey) { _, _ in keyError = nil }
    .onChange(of: voiceProvider) { _, _ in voiceError = nil }
    .onChange(of: voiceKey) { _, _ in voiceError = nil }
    .onChange(of: botName) { _, value in
      if value.count > 120 { botName = String(value.prefix(120)) }
      requestID = UUID().uuidString
    }
    .onChange(of: avatar) { _, _ in requestID = UUID().uuidString }
    .onChange(of: role) { _, _ in requestID = UUID().uuidString }
    .onDisappear { setup.stop() }
  }

  /// One step's page: art, content, pinned buttons and what it does as it opens.
  private func page(_ step: WizardStep) -> some View {
    WizardFocusHost(focus: $focus, isActive: self.step == step) { binding in
      WizardPage(
        stage: step.stage,
        active: self.step == step,
        skip: step == .voice && !voiceOn ? { go(.bot) } : nil,
        focusAnchor: focus.map { _ in "fields-" + step.rawValue },
        motion: motion(step)
      ) {
        switch step {
        case .health: healthPage
        case .choose: choosePage
        case .method: methodPage
        case .signIn: signInPage(binding)
        case .apiKey: apiKeyPage(binding)
        case .test: testPage
        case .voice: voicePage(binding)
        case .bot: botPage(binding)
        }
      } actions: {
        actions(step)
      }
    }
    .navigationBarBackButtonHidden(step == .choose)
    // Keyed by step: replacing the sign-in with the test reuses the same stack slot.
    .task(id: step) { await enter(step) }
  }

  // MARK: - Navigation

  private func go(_ next: WizardStep) {
    guard next != step else { return }
    if [.signIn, .apiKey].contains(step), next == .test {
      // The sign-in is done: Back from the test returns to the choice, not to it.
      var next2 = path
      next2.removeLast()
      next2.append(next)
      path = next2
    } else {
      path.append(next)
    }
  }

  private func goBack() {
    guard !path.isEmpty else { return }
    path.removeLast()
  }

  /// Ends onboarding. With the new bot's chat, Home shows it arriving in the list,
  /// then zooms into it (W8).
  private func finish(landing channel: String? = nil) {
    setup.stop()
    store.finishOnboarding(landing: channel)
  }

  /// What a screen does as it opens. The task ends when the screen is covered.
  private func enter(_ step: WizardStep) async {
    switch step {
    case .health: await runHealth()
    case .choose: await loadAndCheck()
    case .method: break
    case .signIn: await advanceWhenConnected()
    case .test: await testModel()
    case .voice:
      if voiceConfigured, !voiceOn, path.last == .voice {
        // Already set up: nothing to ask.
        var next = path
        next.removeLast()
        next.append(.bot)
        path = next
      }
    case .apiKey:
      try? await Task.sleep(for: .milliseconds(450))
      if !Task.isCancelled, apiKey.isEmpty { focus = .apiKey }
    case .bot: break
    }
  }

  // MARK: - Art

  /// The art behind the page on top. The backdrop morphs between scenes, so the
  /// chat card, the provider's icon and the robot carry from step to step.
  private var scene: WizardScene {
    switch step {
    case .health:
      // The same states as the rows below: passed, being checked, or not running.
      let parts = store.runtime.serverChecks.enumerated().map { index, check in
        let done = healthy || index < ticked || (stalled && check.ready)
        let problem = !done && stalled && !check.ready
        let status: ServerTopologyArt.Status =
          done ? .ok : problem ? .problem : index == ticked ? .checking : .hidden
        return ServerTopologyArt.Part(key: check.key, status: status)
      }
      return .server(parts: parts, host: ServerAddressText.authority(store.server))
    case .choose:
      if !changingModel, let label = savedLabel, setup.test != .idle {
        return .chat(
          reply: chatReply,
          marks: [ProviderMark.kind(for: setup.data?.inference.providerId ?? "")], model: label,
          dark: false, celebrate: celebrate)
      }
      return .chat(
        reply: .typing, marks: [.chatgpt, .claude], model: nil, dark: false, celebrate: celebrate)
    case .method:
      // The plan's mark and the API's, at the chat card's corners.
      return .chat(
        reply: .typing, marks: family.methods.map { ProviderMark.kind(for: $0.providerId) },
        model: nil, dark: false, celebrate: celebrate)
    case .signIn:
      let kind = ProviderMark.kind(for: setup.providerId)
      if let session = setup.session, session.status == "connected" {
        return .connecting(kind: kind, connected: true, waiting: false)
      } else if let code = setup.session?.deviceCode, !setup.finishingSignIn,
        setup.session?.finished != true
      {
        return .deviceCode(code: code.userCode, kind: kind)
      } else if let session = setup.session, !session.finished, !setup.finishingSignIn,
        let host = session.authorizationUrl.flatMap(URL.init(string:))?.host
      {
        return .browser(kind: kind, host: host)
      }
      return .connecting(kind: kind, connected: false, waiting: setup.session?.finished != true)
    case .apiKey:
      return .key(provider: keyProvider, typed: !apiKey.isEmpty, accepted: keyAccepted, single: true)
    case .test:
      return .chat(
        reply: modelProblem != nil ? .failed : chatReply,
        marks: [ProviderMark.kind(for: setup.providerId)],
        model: modelName.isEmpty ? providerName(setup.providerId) : modelName, dark: payoff,
        celebrate: celebrate)
    case .voice:
      return .voice(on: voiceOn)
    case .bot:
      if let bot = arrival?.bot {
        return .bots([.init(id: bot.id, color: bot.color, icon: bot.icon)])
      }
      if !hadBots {
        return .bot(avatar: avatar, name: trimmedName, role: role, shuffles: shuffles)
      }
      return .bots(store.bots.map { .init(id: $0.id, color: $0.color, icon: $0.icon) })
    }
  }

  /// What each page shows, in short. A change springs the page to its new layout.
  private func motion(_ step: WizardStep) -> String {
    switch step {
    case .health: return "\(healthy)|\(stalled)|\(checking)"
    case .choose:
      return
        "\(settingsMissing)|\(loadFailure != nil)|\(savedMode)|\(testPassed)|\(changingModel)|\(setup.test)|\(setup.error ?? "")"
    case .method: return "\(family.id)|\(choosing ?? "")|\(setup.error ?? "")"
    case .signIn:
      let session = setup.session
      return
        "\(session?.status ?? "")|\(session?.deviceCode?.userCode ?? "")|\(session?.prompt?.id ?? "")|\(setup.finishingSignIn)|\(setup.error ?? "")|\(copiedCode ?? "")"
    case .apiKey: return "\(keyAccepted)|\(connectingKey)|\(keyError ?? "")"
    case .test: return "\(setup.test)|\(modelProblem ?? "")|\(setup.error ?? "")|\(setup.modelId)"
    case .voice: return "\(voiceOn)|\(voiceBusy)|\(voiceError ?? "")"
    case .bot: return "\(creating)|\(createError ?? "")|\(hadBots)|\(arrival?.bot.id ?? "")"
    }
  }

  private var chatReply: ChatArt.Reply {
    switch setup.test {
    case .idle, .running: return .typing
    case .passed(let latency): return .ok(seconds: latency / 1000)
    case .failed: return .failed
    }
  }

  // MARK: - W3 Server check

  private func runHealth() async {
    let started = ContinuousClock.now
    await store.refreshRuntime()
    var refreshed = ContinuousClock.now
    while !Task.isCancelled {
      let checks = store.runtime.serverChecks
      if ticked < checks.count, checks[ticked].ready {
        // Rows tick in turn so each one is seen.
        try? await Task.sleep(for: .milliseconds(320))
        guard !Task.isCancelled else { return }
        withAnimation(.snappy) { ticked += 1 }
        continue
      }
      if ticked >= checks.count {
        withAnimation(.smooth) {
          healthy = true
          stalled = false
        }
        UIAccessibility.post(notification: .announcement, argument: "All systems go")
        try? await Task.sleep(for: .milliseconds(900))
        guard !Task.isCancelled, step == .health else { return }
        go(.choose)
        return
      }
      if !stalled, ContinuousClock.now - started > .seconds(15) {
        withAnimation(.smooth) { stalled = true }
      }
      // Look again often, so "Check again" or a return to the app shows up at once;
      // ask the server less often.
      try? await Task.sleep(for: .milliseconds(250))
      guard !Task.isCancelled else { return }
      if ContinuousClock.now - refreshed > .seconds(stalled ? 3 : 1.5) {
        await store.refreshRuntime()
        refreshed = ContinuousClock.now
      }
    }
  }

  @ViewBuilder private var healthPage: some View {
    WizardHeader(
      title: healthy
        ? "All systems go" : stalled ? "Something isn't running yet" : "Checking your server",
      detail: stalled
        ? "Run `openteam doctor` on your server to see why."
        : healthy ? "Everything on your server is running." : "This takes a few seconds.")
    let details = [
      "server": "Answers your apps", "database": "Keeps your chats and bots",
      "queue": "Runs work in the background", "computer": "Gives bots a browser and files",
    ]
    let icons: [String: (String, Color)] = [
      "server": ("server.rack", .blue), "database": ("cylinder.split.1x2.fill", .green),
      "queue": ("tray.full.fill", .orange), "computer": ("desktopcomputer", .purple),
    ]
    WizardGroup {
      ForEach(Array(store.runtime.serverChecks.enumerated()), id: \.element.key) { index, check in
        if index > 0 { WizardDivider(inset: 60) }
        let done = index < ticked || (stalled && check.ready)
        let problem = stalled && !check.ready && index >= ticked
        let waiting = !done && !problem && index == ticked
        WizardRow(
          symbol: icons[check.key]?.0, color: icons[check.key]?.1 ?? .gray, title: check.label,
          subtitle: details[check.key]
        ) {
          HStack(spacing: 6) {
            if problem {
              Text("Not running").font(.footnote.weight(.semibold)).foregroundStyle(.orange)
                .transition(.opacity)
            }
            if waiting {
              LoadingOrb(size: 16, label: "Checking")
            } else {
              Image(
                systemName: done
                  ? "checkmark.circle.fill" : problem ? "exclamationmark.triangle.fill" : "circle.dotted"
              )
              .font(.title3)
              .foregroundStyle(done ? Color.green : problem ? Color.orange : Color.secondary.opacity(0.5))
              .contentTransition(.symbolEffect(.replace))
              .symbolEffect(.bounce, value: done)
            }
          }
          .animation(.snappy, value: done)
          .animation(.snappy, value: problem)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(done ? "Running" : problem ? "Not running" : "Checking")
        .accessibilityIdentifier("health-row-" + check.key)
      }
    }
    .wizardFeedback(.impact(weight: .light), trigger: ticked)
    .wizardFeedback(.success, trigger: healthy, when: { $0 })
    .wizardFeedback(.error, trigger: stalled, when: { $0 })
  }

  private func checkAgain() async {
    checking = true
    await store.refreshRuntime()
    checking = false
  }

  // MARK: - W4 Choose

  private func providerName(_ id: String) -> String {
    APIKeyProviders.option(id)?.title ?? ModelSetupCatalog.name(id, in: setup.data)
  }
  private var savedLabel: String? {
    guard let data = setup.data, let saved = data.savedModel else { return nil }
    // The dropdown's pick while it's saved and tested, otherwise the saved model.
    let id = setup.providerId == saved.providerId && !setup.modelId.isEmpty
      ? setup.modelId : saved.modelId
    let model = data.models.first { $0.modelId == id }?.name ?? id
    return providerName(saved.providerId) + " · " + model
  }
  /// A model is already saved and hasn't failed its test: the screen offers to keep
  /// it (desktop's "You're already connected") instead of the provider list.
  private var savedMode: Bool {
    guard !changingModel, setup.data?.savedModel != nil else { return false }
    switch setup.test {
    case .failed: return false
    case .idle: return !savedChecked || setup.busy != nil
    case .running, .passed: return true
    }
  }
  /// The saved model's check failed. Usually a blip, so the screen offers to try it
  /// again; the provider list waits until the person asks for a different AI.
  private var savedFailure: String? {
    guard !changingModel, setup.data?.savedModel != nil, case .failed(let error) = setup.test
    else { return nil }
    return error
  }
  /// The AI settings haven't loaded: still loading, or failed (with the reason).
  private var settingsMissing: Bool { setup.data == nil }
  private var loadFailure: String? { settingsMissing && setup.busy == nil ? setup.error : nil }

  /// Loads the AI settings, then checks a saved model once.
  private func loadAndCheck() async {
    await setup.start()
    if !savedChecked, setup.data?.savedModel != nil, setup.test == .idle, setup.session == nil {
      savedChecked = true
      await setup.runTest()
    }
  }

  @ViewBuilder private var choosePage: some View {
    let saved = savedMode ? savedLabel : nil
    let label = savedLabel ?? "Your saved AI"
    // One header for the page, so a change of state blurs its words over in place.
    WizardHeader(
      title: settingsMissing
        ? loadFailure == nil ? "Checking your AI" : "Couldn't load your AI settings"
        : savedFailure != nil
          ? "Your AI didn't reply"
          : saved == nil
            ? "Choose your bots' AI" : testPassed ? "You're already connected" : "Checking your AI",
      detail: settingsMissing
        ? loadFailure == nil
          ? "Loading your server's AI settings…" : "Your server didn't send them this time."
        : savedFailure != nil
          ? "\(label) didn't answer the check."
          : saved.map {
            testPassed
              ? "\($0) is connected and replying." : "Checking the AI your server already uses…"
          } ?? "Use a ChatGPT or Claude plan you already pay for, or an API key.")
    if settingsMissing {
      if let loadFailure { WizardError(message: loadFailure, identifier: "model-load-error") }
    } else if let failure = savedFailure {
      WizardGroup {
        WizardRow(
          provider: ProviderMark.kind(for: setup.data?.inference.providerId ?? ""), title: label,
          subtitle: "Didn't reply"
        ) {
          Image(systemName: "exclamationmark.triangle.fill").font(.title3).foregroundStyle(.orange)
            .transition(.symbolEffect(.appear))
        }
        WizardDivider(inset: 60)
        // The test already played its error haptic.
        WizardError(message: failure, identifier: "model-test-status", haptic: false)
          .padding(.horizontal, 12).padding(.vertical, 12)
      }
    } else if let label = saved {
      WizardGroup(selected: testPassed ? WizardStage.model.accent : nil) {
        HStack(spacing: 14) {
          ProviderMark(
            kind: ProviderMark.kind(for: setup.data?.inference.providerId ?? ""), size: 30,
            style: .icon)
          VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.body)
            Group {
              if case .passed(let latency) = setup.test {
                Text("Working · replied in \(String(format: "%.1f", latency / 1000)) s")
                  .foregroundStyle(.green)
                  .contentTransition(.numericText(value: latency))
              } else {
                Text("Testing…").foregroundStyle(.secondary)
              }
            }
            .font(.subheadline)
          }
          Spacer(minLength: 8)
          if testPassed {
            Image(systemName: "checkmark.circle.fill").font(.title3).foregroundStyle(.green)
              .transition(.symbolEffect(.appear))
          } else {
            LoadingOrb(label: "Testing")
          }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .animation(.snappy, value: testPassed)
        .accessibilityElement(children: .combine).accessibilityIdentifier("model-test-status")
      }
      // The model can change here too; a new one is saved and tested again.
      if let models = setup.data?.models, models.count > 1 {
        WizardGroup { modelDropdown(models) }
      }
    } else {
      WizardGroup {
        familyRow(ProviderFamilies.chatgpt)
        WizardDivider(inset: 60)
        familyRow(ProviderFamilies.claude)
        WizardDivider(inset: 60)
        providerRow(id: "openrouter", title: "OpenRouter", detail: "One account, hundreds of models")
        let others = ModelSetupCatalog.others(setup.data?.providers ?? [])
        if !others.isEmpty {
          WizardDivider(inset: 60)
          Menu {
            ForEach(others) { provider in
              Button(provider.name) { Task { await choose(provider.id) } }
            }
          } label: {
            WizardRow(
              symbol: "ellipsis", color: .blue, title: "More providers",
              subtitle: others.prefix(3).map(\.name).joined(separator: ", ")
                + (others.count > 3 ? ", and more" : "")
            ) {
              if let choosing, others.contains(where: { $0.id == choosing }) {
                LoadingOrb(label: "Working")
              } else {
                Image(systemName: "chevron.up.chevron.down").font(.footnote.weight(.semibold))
                  .foregroundStyle(.tertiary)
              }
            }
          }
          .buttonStyle(WizardRowButtonStyle())
          .disabled(setup.data == nil || choosing != nil)
          .accessibilityIdentifier("provider-more")
        }
      }
      .wizardFeedback(.selection, trigger: choosing, when: { $0 != nil })
    }
    if let error = setup.error, !settingsMissing { WizardError(message: error) }
  }

  @ViewBuilder private func rowAccessory(busy: Bool) -> some View {
    if busy {
      LoadingOrb(label: "Working")
    } else {
      Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
    }
  }

  /// ChatGPT or Claude: the next step asks whether to use the plan or an API key.
  private func familyRow(_ family: ProviderFamily) -> some View {
    Button {
      setup.error = nil
      self.family = family
      go(.method)
    } label: {
      WizardRow(
        provider: ProviderMark.kind(for: family.methods[0].providerId), title: family.title,
        subtitle: family.detail
      ) {
        rowAccessory(busy: false)
      }
    }
    .buttonStyle(WizardRowButtonStyle())
    .disabled(setup.data == nil || choosing != nil)
    .accessibilityLabel(family.title + ". " + family.detail)
    .accessibilityIdentifier("provider-card-" + family.id)
  }

  /// A provider that only takes a key (OpenRouter).
  private func providerRow(id: String, title: String, detail: String) -> some View {
    Button {
      Task { await chooseKeyProvider(id) }
    } label: {
      WizardRow(provider: ProviderMark.kind(for: id), title: title, subtitle: detail) {
        rowAccessory(busy: choosing == id)
      }
    }
    .buttonStyle(WizardRowButtonStyle())
    .disabled(setup.data == nil || choosing != nil)
    .accessibilityLabel(title + ". " + detail)
    .accessibilityIdentifier("provider-card-" + id)
  }

  /// Loads the provider; a connected one goes straight to the test, others sign in.
  private func choose(_ id: String) async {
    guard choosing == nil else { return }
    let from = step
    choosing = id
    defer { choosing = nil }
    setup.cancelSignIn()
    setup.error = nil
    await setup.selectProvider(id, reload: true)
    guard step == from, let provider = setup.provider, provider.id == id, setup.error == nil
    else { return }
    if provider.connected {
      go(.test)
    } else if provider.authMethods.first?.type == "api_key" {
      openKeyStep(id)
    } else {
      go(.signIn)
      await setup.connect()
    }
  }

  /// A provider used with a key (OpenRouter, or an OpenAI or Anthropic key): already
  /// connected goes to the test, otherwise the key screen opens for that provider.
  private func chooseKeyProvider(_ id: String) async {
    guard choosing == nil else { return }
    let from = step
    choosing = id
    defer { choosing = nil }
    setup.cancelSignIn()
    setup.error = nil
    await setup.selectProvider(id, reload: true)
    guard step == from, setup.error == nil else { return }
    if setup.provider?.connected == true {
      go(.test)
    } else {
      openKeyStep(id)
    }
  }

  private func openKeyStep(_ id: String) {
    if keyProvider != id { apiKey = "" }
    keyProvider = id
    keyError = nil
    keyAccepted = false
    go(.apiKey)
  }

  // MARK: - W4c Plan or key

  @ViewBuilder private var methodPage: some View {
    WizardHeader(
      title: "Connect \(family.title)",
      detail: "Sign in with the plan you already pay for, or use an API key billed per use.")
    WizardGroup {
      ForEach(Array(family.methods.enumerated()), id: \.element.id) { index, method in
        if index > 0 { WizardDivider(inset: 60) }
        Button {
          Task {
            if method.authType == "api_key" {
              await chooseKeyProvider(method.providerId)
            } else {
              await choose(method.providerId)
            }
          }
        } label: {
          WizardRow(
            provider: ProviderMark.kind(for: method.providerId), title: method.title,
            subtitle: method.detail
          ) {
            rowAccessory(busy: choosing == method.providerId)
          }
        }
        .buttonStyle(WizardRowButtonStyle())
        .disabled(setup.data == nil || choosing != nil)
        .accessibilityLabel(method.title + ". " + method.detail)
        .accessibilityIdentifier("method-" + method.providerId)
      }
    }
    .wizardFeedback(.selection, trigger: choosing, when: { $0 != nil })
    if let error = setup.error { WizardError(message: error) }
  }

  // MARK: - Model dropdown

  private func modelDropdown(_ models: [InferenceModel]) -> some View {
    ModelDropdown(
      models: models, selected: setup.modelId,
      recommended: setup.data?.recommendedModel?.modelId,
      disabled: setup.busy != nil || setup.test == .running,
      search: { choosingModel = true }, choose: changeModel)
  }

  /// A different model from the dropdown is saved and tested again.
  private func changeModel(_ id: String) {
    guard id != setup.modelId else { return }
    setup.selectModel(id)
    Task { await setup.apply() }
  }

  // MARK: - W4a Browser or device-code sign-in

  private func advanceWhenConnected() async {
    while !Task.isCancelled, setup.session?.status != "connected" {
      try? await Task.sleep(for: .milliseconds(150))
    }
    guard !Task.isCancelled else { return }
    try? await Task.sleep(for: .milliseconds(900))
    guard !Task.isCancelled, step == .signIn else { return }
    go(.test)
  }

  /// The sign-in page's headline for where the sign-in has got to.
  private var signInHeader: (title: String, detail: String) {
    let session = setup.session
    let name = providerName(setup.providerId)
    if session?.status == "connected" {
      return ("You're signed in", "Connected to \(name).")
    } else if let session, session.status == "failed" || session.status == "cancelled" {
      return (
        "That didn't work",
        session.status == "cancelled"
          ? "The sign-in was cancelled." : "The sign-in to \(name) didn't finish."
      )
    } else if setup.finishingSignIn {
      return ("Finishing sign-in", "Connecting to \(name). This takes a moment.")
    } else if session?.deviceCode != nil {
      return (
        "Enter this code to sign in",
        "Open the sign-in page and type this code. We'll continue automatically."
      )
    } else if let session, !session.finished, session.authorizationUrl != nil {
      return ("Finish signing in in your browser", "We'll bring you back here automatically.")
    } else if let session, !session.finished, let prompt = session.prompt,
      session.automaticAnswer == nil
    {
      return ("Sign in to \(name)", prompt.message)
    }
    return ("Connecting to \(name)", "This takes a moment.")
  }

  @ViewBuilder private func signInPage(_ focusBinding: FocusBinding) -> some View {
    let session = setup.session
    let name = providerName(setup.providerId)
    let header = signInHeader
    // One header for the page, so each stage of the sign-in blurs its words over in place.
    WizardHeader(title: header.title, detail: header.detail)
    if session?.status == "connected" {
      EmptyView()
    } else if let session, session.status == "failed" || session.status == "cancelled" {
      WizardError(message: session.error ?? "Try again, or choose a different method.")
    } else if setup.finishingSignIn {
      WizardGroup {
        WizardStatusLine(text: "Almost done…").padding(16)
          .accessibilityIdentifier("sign-in-waiting")
      }
    } else if let code = session?.deviceCode {
      WizardGroup {
        let copied = copiedCode == code.userCode
        WizardRow(
          symbol: copied ? "doc.on.clipboard.fill" : "doc.on.doc", color: WizardStage.model.accent,
          title: copied ? "Code copied" : "Copy the code"
        ) {
          Button(copied ? "Copy again" : "Copy code") {
            UIPasteboard.general.string = code.userCode
            NativeHaptics.play(.light, source: "onboarding.copy-code")
            copiedCode = code.userCode
          }
          .buttonStyle(.bordered).controlSize(.small)
          .accessibilityIdentifier("device-code-copy")
        }
        WizardDivider(inset: 60)
        WizardStatusLine(text: "Waiting for you to finish signing in…")
          .padding(.horizontal, 16).padding(.vertical, 14)
          .accessibilityIdentifier("sign-in-waiting")
      }
      if setup.providerId == "openai-codex" {
        WizardFootnote("Code not accepted? Turn on device code sign-in in ChatGPT → Settings → Security.")
          .accessibilityIdentifier("device-code-hint")
      }
    } else if let session, !session.finished, session.authorizationUrl != nil {
      WizardGroup {
        WizardStatusLine(text: "Waiting for you to sign in to \(name)…")
          .padding(.horizontal, 16).padding(.vertical, 14)
          .accessibilityIdentifier("sign-in-waiting")
        if let prompt = session.prompt, session.automaticAnswer == nil {
          WizardDivider()
          Text(
            session.capturableRedirect != nil
              ? "Signed in in Safari? Its last page won't load. Copy that page's address and paste it here."
              : prompt.type == "manual_code"
                ? "After you sign in, copy the address your browser lands on and paste it here."
                : prompt.message
          )
          .font(.subheadline).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, 16).padding(.top, 12)
          promptField(prompt, focusBinding)
        }
      }
      .id("fields-signIn")
    } else if let session, !session.finished, let prompt = session.prompt,
      session.automaticAnswer == nil
    {
      WizardGroup { promptField(prompt, focusBinding) }.id("fields-signIn")
    } else {
      WizardGroup {
        WizardStatusLine(text: "Starting sign-in…", symbol: "antenna.radiowaves.left.and.right")
          .padding(16).accessibilityIdentifier("sign-in-waiting")
      }
    }
    if let error = setup.error { WizardError(message: error) }
  }

  @ViewBuilder private func promptField(
    _ prompt: InferenceAuthPrompt, _ focusBinding: FocusBinding
  ) -> some View {
    HStack(spacing: 10) {
      if prompt.type == "select" {
        Picker(prompt.message.isEmpty ? "Choose" : prompt.message, selection: $pasted) {
          Text("Choose…").tag("")
          ForEach(prompt.options ?? []) { option in Text(option.label).tag(option.id) }
        }
        .pickerStyle(.menu).accessibilityIdentifier("sign-in-prompt")
        Spacer(minLength: 0)
      } else {
        Group {
          if prompt.type == "secret" {
            SecureField("Paste it here", text: $pasted)
          } else {
            TextField(
              prompt.type == "manual_code"
                ? "Paste the address" : (prompt.placeholder ?? "Type it here"), text: $pasted)
          }
        }
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .keyboardType(prompt.type == "manual_code" ? .URL : .default)
        .submitLabel(.continue).focused(focusBinding, equals: .paste)
        .onSubmit { submitPrompt(prompt) }
        .accessibilityLabel(
          prompt.type == "manual_code" ? "Address from your browser" : prompt.message)
        .accessibilityIdentifier("sign-in-paste")
      }
      Button {
        submitPrompt(prompt)
      } label: {
        if setup.busy == .respond { PrimaryLoadingOrb(label: "Working") } else { Text("Continue") }
      }
      .buttonStyle(.borderedProminent).controlSize(.small).tint(NativePalette.text)
      .foregroundStyle(NativePalette.onPrimary)
      .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || setup.busy != nil)
      .accessibilityIdentifier("sign-in-paste-continue")
    }
    .padding(.horizontal, 16).frame(minHeight: 56)
  }

  private func submitPrompt(_ prompt: InferenceAuthPrompt) {
    let value = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty, setup.busy != .respond else { return }
    focus = nil
    Task { await setup.respond(prompt.id, value) }
  }

  private func retrySignIn() async {
    let method = setup.session?.authType
    setup.cancelSignIn()
    setup.error = nil
    await setup.connect(method)
  }

  // MARK: - W4b API key

  @ViewBuilder private func apiKeyPage(_ focusBinding: FocusBinding) -> some View {
    let name = providerName(keyProvider)
    WizardHeader(
      title: "Paste your \(name) key",
      detail: "It's checked with \(name), then stored on your server.")
    WizardGroup {
      HStack(spacing: 12) {
        Image(systemName: "key.fill").foregroundStyle(.secondary)
        SecureField("Paste your key", text: $apiKey)
          .textContentType(.password)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .submitLabel(.go).focused(focusBinding, equals: .apiKey)
          .onSubmit { Task { await submitKey() } }
          .disabled(connectingKey)
          .accessibilityLabel("\(name) API key")
          .accessibilityIdentifier("api-key-field")
        if keyAccepted { WizardCheck(size: 22) }
      }
      .modifier(WizardFieldStyle())
      if connectingKey, !keyAccepted {
        WizardDivider()
        WizardStatusLine(text: "Checking the key with \(name)…", symbol: "checkmark.shield")
          .padding(.horizontal, 16).padding(.vertical, 14)
          .accessibilityIdentifier("api-key-checking")
          .transition(.move(edge: .top).combined(with: .opacity))
      }
    }
    .animation(.snappy, value: connectingKey)
    .id("fields-apiKey")
    .wizardFeedback(.success, trigger: keyAccepted, when: { $0 })
    if let keyError, !keyAccepted {
      WizardError(message: keyError, identifier: "api-key-error")
    }
  }

  /// Connects the key and proves it (it lists models, and a real request works) before
  /// moving on; a key that doesn't work keeps the page, with the reason.
  private func submitKey() async {
    let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !key.isEmpty, !connectingKey else { return }
    let id = keyProvider
    focus = nil
    keyError = nil
    connectingKey = true
    defer { connectingKey = false }
    setup.cancelSignIn()
    setup.error = nil
    let failure = await setup.connectKey(key, provider: id, name: providerName(id))
    guard step == .apiKey else { return }
    if let failure {
      withAnimation(.snappy) { keyError = failure }
      NativeHaptics.play(.error, source: "onboarding.api-key")
      return
    }
    if id == "openai" { openAIKey = key }
    celebrateOnArrival = true
    connectingKey = false
    withAnimation(.bouncy) { keyAccepted = true }
    try? await Task.sleep(for: .milliseconds(800))
    guard step == .apiKey else { return }
    go(.test)
  }

  // MARK: - W5 Test

  private var modelName: String { setup.selectedModel?.name ?? setup.modelId }

  private func testModel(force: Bool = false) async {
    modelProblem = nil
    if !force {
      if case .passed = setup.test, !setup.changed {
        // A key is tested before this page opens: the confetti waits for it.
        if celebrateOnArrival {
          celebrateOnArrival = false
          try? await Task.sleep(for: .milliseconds(300))
          guard !Task.isCancelled else { return }
          celebrate += 1
          UIAccessibility.post(notification: .announcement, argument: "It works!")
        }
        return
      }
      await setup.reload()
    }
    guard setup.provider?.connected == true, !(setup.data?.models.isEmpty ?? true),
      !setup.modelId.isEmpty
    else {
      withAnimation(.snappy) {
        modelProblem =
          setup.error ?? setup.provider?.modelMessage ?? "This account doesn't offer any chat models."
      }
      return
    }
    await setup.apply()
    if case .passed = setup.test {
      UIAccessibility.post(notification: .announcement, argument: "It works!")
    }
  }

  /// The test page's headline: the question, the answer, or the failure.
  private var testHeader: (title: String, detail: String) {
    if modelProblem != nil {
      return ("That didn't work", "\(providerName(setup.providerId)) didn't reply.")
    }
    switch setup.test {
    case .passed: return ("It works!", setup.test.replySentence(model: modelName) ?? "")
    case .failed: return ("That didn't work", "\(modelName) didn't reply.")
    case .idle, .running:
      return (
        "Let's make sure it works",
        modelName.isEmpty ? "Saving your choice…" : "Sending a quick test message to \(modelName)."
      )
    }
  }

  @ViewBuilder private var testPage: some View {
    let header = testHeader
    let passed = modelProblem == nil && testPassed
    // One header: "Let's make sure it works" blurs into "It works!" as the check pops
    // in beside it and confetti bursts from it.
    WizardHeader(
      title: header.title, detail: header.detail,
      detailIdentifier: passed ? "model-test-status" : "wizard-detail"
    ) {
      if passed {
        ZStack {
          CelebrationBurst(
            trigger: celebrate,
            colors: [WizardStage.model.accent, .green, .orange, .pink, .yellow], radius: 70,
            delay: 0.16)
          WizardCheck(size: 40)
        }
        .transition(.scale(scale: 0.4).combined(with: .opacity))
      }
    }
    if let modelProblem {
      WizardError(message: modelProblem, identifier: "model-test-status")
    } else {
      switch setup.test {
      case .passed:
        modelMenu
      case .failed(let error):
        // The model test already played its error haptic.
        WizardError(message: error, identifier: "model-test-status", haptic: false)
        modelMenu
      case .idle, .running:
        WizardGroup {
          WizardStatusLine(
            text: setup.test == .running ? "Waiting for \(modelName) to reply…" : "Saving your choice…",
            symbol: "ellipsis.bubble"
          )
          .padding(16)
          .accessibilityIdentifier("model-test-status")
        }
        modelMenu
      }
    }
    if let error = setup.error, modelProblem == nil { WizardError(message: error) }
  }

  /// The provider's models, in its own order; a new pick is saved and tested again.
  @ViewBuilder private var modelMenu: some View {
    if let models = setup.data?.models, models.count > 1 {
      WizardGroup { modelDropdown(models) }
    }
  }

  // MARK: - W6 Voice

  @ViewBuilder private func voicePage(_ focusBinding: FocusBinding) -> some View {
    WizardHeader(
      title: voiceOn ? "Voice notes are on" : "Talk instead of type?",
      detail: voiceOn
        ? "Tap the microphone in any chat to talk instead of type."
        : "Record a message and your server turns it into text. Needs an OpenAI or Deepgram key.",
      detailIdentifier: voiceOn ? "voice-on" : "wizard-detail"
    ) {
      if voiceOn {
        WizardCheck(size: 36).transition(.scale(scale: 0.4).combined(with: .opacity))
      }
    }
    if !voiceOn {
      if let openAIKey {
        WizardGroup(selected: WizardStage.voice.accent) {
          Button {
            Task { await turnOnVoice(.openai, key: openAIKey) }
          } label: {
            WizardRow(
              provider: .openai,
              title: "Use the same OpenAI key", subtitle: "The one you just added for your bots"
            ) {
              if voiceBusy, voiceKey.isEmpty {
                LoadingOrb(label: "Working")
              } else {
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
                  .foregroundStyle(.tertiary)
              }
            }
          }
          .buttonStyle(WizardRowButtonStyle()).disabled(voiceBusy)
          .accessibilityIdentifier("voice-same-key")
        }
      }
      WizardProviderChoice(
        options: [TranscriptionSettings.Provider.openai, .deepgram].map {
          .init(id: $0.rawValue, title: $0.title, kind: ProviderMark.kind(for: $0))
        },
        selection: Binding(
          get: { voiceProvider.rawValue },
          set: { voiceProvider = TranscriptionSettings.Provider(rawValue: $0) ?? .openai }),
        identifier: "voice-provider", disabled: voiceBusy
      )
      .wizardFeedback(.selection, trigger: voiceProvider)
      WizardGroup(header: openAIKey == nil ? nil : "Or use another key") {
        HStack(spacing: 12) {
          Image(systemName: "key.fill").foregroundStyle(.secondary)
          SecureField("Paste your \(voiceProvider.title) key", text: $voiceKey)
            .textContentType(.password)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .submitLabel(.go).focused(focusBinding, equals: .voiceKey)
            .onSubmit { Task { await turnOnVoice(voiceProvider, key: voiceKey) } }
            .disabled(voiceBusy)
            .accessibilityLabel("\(voiceProvider.title) key")
            .accessibilityIdentifier("voice-key-field")
        }
        .modifier(WizardFieldStyle())
      }
      .id("fields-voice")
      if let voiceError { WizardError(message: voiceError) }
    }
  }

  /// Saves the service and key, then proves it works before moving on.
  private func turnOnVoice(_ provider: TranscriptionSettings.Provider, key: String) async {
    let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !voiceBusy, !key.isEmpty else { return }
    focus = nil
    voiceBusy = true
    voiceError = nil
    defer { voiceBusy = false }
    var draft = TranscriptionDraft(voice)
    draft.choose(provider)
    draft.settings.enabled = true
    draft.apiKey = key
    do {
      let saved = try await store.request(
        TranscriptionRequest.path, method: "PATCH", body: draft.body
      ).decode(TranscriptionSettingsView.self)
      voice = saved
      let check = try await store.request(
        TranscriptionRequest.checkPath, method: "POST", body: .object([:]), timeout: 90
      ).decode(TranscriptionCheck.self)
      if check.level == "fail" {
        withAnimation(.snappy) { voiceError = check.detail.isEmpty ? "That key didn't work." : check.detail }
        // Leave voice notes off rather than on with a key that doesn't work.
        var off = TranscriptionDraft(saved)
        off.settings.enabled = false
        if let value = try? await store.request(
          TranscriptionRequest.path, method: "PATCH", body: off.body
        ).decode(TranscriptionSettingsView.self) {
          voice = value
        }
        await store.refreshRuntime()
        return
      }
      await store.refreshRuntime()
      UIAccessibility.post(notification: .announcement, argument: "Voice notes are on")
      withAnimation(.bouncy) { voiceOn = true }
      try? await Task.sleep(for: .milliseconds(1000))
      guard step == .voice else { return }
      go(.bot)
    } catch {
      guard !UserFacingError.isCancelled(error) else { return }
      withAnimation(.snappy) { voiceError = UserFacingError.message(error) }
    }
  }

  // MARK: - W7 First bot

  private var trimmedName: String { botName.trimmingCharacters(in: .whitespacesAndNewlines) }
  /// The server had bots before setup opened, so there's no first bot to make.
  private var hadBots: Bool { !(botsAtStart ?? Set(store.bots.map(\.id))).isEmpty }
  /// A bot that appeared while this screen was open (live updates bring it in).
  private var arrival: FirstBot.Arrival? {
    guard let botsAtStart, !creating else { return nil }
    return FirstBot.arrival(
      bots: store.bots, existing: botsAtStart, sent: sentBots, ignoring: setAsideBots)
  }

  @ViewBuilder private func botPage(_ focusBinding: FocusBinding) -> some View {
    if let arrival {
      let bot = arrival.bot
      switch arrival {
      case .ours:
        WizardHeader(title: "\(bot.name) is ready", detail: "Your bot was created. Open it to say hello.")
      case .elsewhere:
        WizardHeader(
          title: "\(bot.name) was just created on another device",
          detail: "Open it to start chatting, or create a bot of your own too.")
      }
      WizardGroup {
        HStack(spacing: 14) {
          BotGlyph(color: Color(hex: bot.color), kind: bot.icon, size: 40)
          VStack(alignment: .leading, spacing: 2) {
            Text(bot.name).font(.body)
            if !bot.description.isEmpty {
              Text(bot.description).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
          }
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("bot-arrival")
      }
    } else if hadBots {
      WizardHeader(
        title: "You're all set",
        detail: "Your server already has bots. Open OpenTeam to chat with them.")
    } else {
      WizardHeader(
        title: "Create your first bot",
        detail: "Give it a name and a job. You can change these anytime.")
      WizardGroup {
        HStack(spacing: 10) {
          TextField("Name", text: $botName)
            .textContentType(.name)
            .textInputAutocapitalization(.words).autocorrectionDisabled()
            .submitLabel(.done).focused(focusBinding, equals: .botName)
            .onSubmit { focus = nil }
            .accessibilityLabel("Bot name")
            .accessibilityIdentifier("bot-name-field")
          Button {
            withAnimation(.bouncy) {
              avatar = FirstBot.randomAvatar(excluding: avatar)
              shuffles += 1
            }
          } label: {
            Label("Shuffle", systemImage: "shuffle")
              .symbolEffect(.bounce, value: shuffles)
          }
          .buttonStyle(.bordered).controlSize(.small)
          .accessibilityLabel("Shuffle avatar")
          .accessibilityIdentifier("bot-shuffle")
        }
        .modifier(WizardFieldStyle())
      }
      .id("fields-bot")
      .wizardFeedback(.impact(weight: .light), trigger: shuffles)
      WizardGroup(header: "Job") {
        WizardFlowLayout(spacing: 8) {
          ForEach(FirstBot.roles) { candidate in roleChip(candidate) }
        }
        .padding(12)
      }
      .wizardFeedback(.selection, trigger: role)
      if let createError { WizardError(message: createError) }
    }
  }

  private func roleChip(_ candidate: BotRole) -> some View {
    let selected = candidate == role
    return Button {
      withAnimation(.snappy) { role = candidate }
    } label: {
      Text(candidate.title).font(.subheadline.weight(.medium))
        .foregroundStyle(selected ? NativePalette.onPrimary : .primary)
        .padding(.horizontal, 14).frame(minHeight: 36)
        .background(selected ? Color.primary : Color(uiColor: .tertiarySystemFill), in: Capsule())
        .contentShape(Capsule())
        .scaleEffect(selected ? 1.04 : 1)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityHint(candidate.description)
    .accessibilityIdentifier("bot-role-" + candidate.id)
  }

  private func createBot() async {
    guard !creating, !trimmedName.isEmpty else { return }
    focus = nil
    creating = true
    createError = nil
    defer { creating = false }
    // The same profile keeps its request ID, so a retry after a lost answer can't make
    // a second bot; and if the bot turns up before the retry, it's known as ours.
    let body = FirstBot.body(requestId: requestID, name: trimmedName, avatar: avatar, role: role)
    sentBots.insert(FirstBot.Request(body: body))
    do {
      let result = try await store.request("/api/v0/bots", method: "POST", body: body)
      NativeHaptics.play(.success, source: "onboarding.create-bot")
      await store.refresh()
      let channel = result["dmChannelId"].string
      // Home shows the new bot arriving, then zooms into its chat for the greeting.
      finish(landing: channel.isEmpty ? nil : channel)
    } catch {
      guard !UserFacingError.isCancelled(error) else { return }
      withAnimation(.snappy) { createError = UserFacingError.message(error) }
    }
  }

  /// Leaves the bot made on another device and goes back to making one here, with a
  /// different name if the two would clash.
  private func createMineToo(_ other: Bot) {
    NativeHaptics.play(.selection, source: "onboarding.create-mine")
    withAnimation(.smooth) {
      setAsideBots.insert(other.id)
      createError = nil
      if trimmedName.caseInsensitiveCompare(other.name) == .orderedSame {
        botName = FirstBot.randomName(excluding: store.bots.map(\.name))
      }
    }
  }

  // MARK: - Pinned buttons

  @ViewBuilder private func actions(_ step: WizardStep) -> some View {
    switch step {
    case .health:
      if stalled {
        WizardPrimaryButton(title: "Check again", busy: checking) {
          Task { await checkAgain() }
        }
        WizardLink(title: "Continue anyway", identifier: "wizard-continue-anyway") {
          go(.choose)
        }
      }
    case .choose:
      if settingsMissing {
        if loadFailure != nil {
          WizardPrimaryButton(title: "Try again") { Task { await loadAndCheck() } }
        }
        WizardLink(
          title: "Skip for now", identifier: "wizard-skip",
          detail: "Bots can't reply until you connect one"
        ) { finish() }
      } else if savedMode || savedFailure != nil {
        // One button: "Keep it" while the check runs or once it passes, "Try again" if it failed.
        let failed = savedFailure != nil
        WizardPrimaryButton(title: failed ? "Try again" : "Keep it", busy: !failed && !testPassed) {
          if failed {
            Task { await setup.runTest() }
          } else {
            go(WizardStep.afterModel(voiceConfigured: voiceConfigured))
          }
        }
        WizardLink(
          title: failed ? "Choose a different AI" : "Use a different AI",
          identifier: "wizard-different-ai"
        ) {
          withAnimation(.smooth) { changingModel = true }
        }
      } else {
        WizardLink(
          title: "Skip for now", identifier: "wizard-skip",
          detail: "Bots can't reply until you connect one"
        ) { finish() }
      }
    case .method:
      EmptyView()
    case .signIn:
      signInActions
    case .apiKey:
      WizardPrimaryButton(
        title: keyAccepted ? "Connected" : connectingKey ? "Checking…" : "Connect",
        symbol: keyAccepted ? "checkmark" : nil,
        busy: connectingKey,
        disabled: apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || keyAccepted
      ) { Task { await submitKey() } }
      if let option = APIKeyProviders.option(keyProvider) {
        WizardLink(title: "Get a key from \(option.title)", identifier: "api-key-help") {
          openURL(option.keyPage)
        }
      }
    case .test:
      if modelProblem != nil {
        WizardPrimaryButton(title: "Try again") { Task { await testModel() } }
        WizardLink(title: "Choose a different AI", identifier: "wizard-different-ai") {
          goBack()
        }
      } else {
        switch setup.test {
        case .passed:
          WizardPrimaryButton(title: "Continue", disabled: setup.busy != nil) {
            go(WizardStep.afterModel(voiceConfigured: voiceConfigured))
          }
        case .failed:
          WizardPrimaryButton(title: "Try again", busy: setup.busy != nil) {
            Task { await testModel(force: true) }
          }
          WizardLink(title: "Choose a different AI", identifier: "wizard-different-ai") {
            goBack()
          }
        case .idle, .running: EmptyView()
        }
      }
    case .voice:
      if !voiceOn {
        WizardPrimaryButton(
          title: "Turn on voice notes", busy: voiceBusy && !voiceKey.isEmpty,
          disabled: voiceKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || voiceBusy
        ) { Task { await turnOnVoice(voiceProvider, key: voiceKey) } }
      }
    case .bot:
      if let arrival {
        WizardPrimaryButton(title: "Open \(arrival.bot.name)") {
          NativeHaptics.play(.light, source: "onboarding.open")
          finish(landing: arrival.bot.dmChannelId)
        }
        if case .elsewhere(let bot) = arrival {
          WizardLink(title: "Create mine too", identifier: "bot-create-mine") {
            createMineToo(bot)
          }
        }
      } else if !hadBots {
        WizardPrimaryButton(
          title: creating
            ? "Creating \(trimmedName)…" : "Create \(trimmedName.isEmpty ? "bot" : trimmedName)",
          busy: creating, disabled: trimmedName.isEmpty || store.syncingState
        ) { Task { await createBot() } }
      } else {
        WizardPrimaryButton(title: "Open OpenTeam") {
          NativeHaptics.play(.light, source: "onboarding.open")
          finish()
        }
      }
    }
  }

  @ViewBuilder private var signInActions: some View {
    let session = setup.session
    if session?.status == "connected" {
      EmptyView()
    } else if let session, session.finished {
      WizardPrimaryButton(title: "Try again") { Task { await retrySignIn() } }
      WizardLink(title: "Use a different method", identifier: "sign-in-other-method") { goBack() }
    } else if setup.finishingSignIn {
      EmptyView()
    } else if session == nil, setup.error != nil, setup.busy == nil {
      WizardPrimaryButton(title: "Try again") { Task { await retrySignIn() } }
      WizardLink(title: "Use a different method", identifier: "sign-in-other-method") { goBack() }
    } else if let code = session?.deviceCode, let url = URL(string: code.verificationUri) {
      WizardPrimaryButton(title: "Open sign-in page") {
        UIPasteboard.general.string = code.userCode
        copiedCode = code.userCode
        openURL(url)
      }
      WizardLink(title: "Use a different method", identifier: "sign-in-other-method") { goBack() }
    } else if let session, session.capturableRedirect != nil,
      let url = session.authorizationUrl.flatMap(URL.init(string:))
    {
      WizardPrimaryButton(title: "Open it again") { setup.openWebSignIn() }
      WizardLink(title: "Open in Safari instead", identifier: "sign-in-safari") { openURL(url) }
      WizardLink(title: "Use a different method", identifier: "sign-in-other-method") { goBack() }
    } else if let url = session?.authorizationUrl.flatMap(URL.init(string:)) {
      WizardPrimaryButton(title: "Open sign-in page") { openURL(url) }
      WizardLink(title: "Use a different method", identifier: "sign-in-other-method") { goBack() }
    } else {
      WizardLink(title: "Cancel", identifier: "sign-in-other-method") { goBack() }
    }
  }
}
