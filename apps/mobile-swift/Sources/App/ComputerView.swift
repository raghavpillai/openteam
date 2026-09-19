import SwiftUI

struct ComputerView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  let bot: Bot
  var handoffID: String? = nil
  @State private var finishedHandoff = false
  @State private var finishRequestID = UUID().uuidString
  @State private var status: JSON = .null
  @State private var frames = ComputerFrames()
  @State private var hasFrame = false
  @State private var text = ""
  @State private var busy = false
  @State private var failure: String?
  @State private var statusFailure: String?
  @State private var frameFailure: String?
  @State private var paused = false
  @State private var trackpad = false
  @State private var heartbeat = Date.distantPast
  @State private var controlRevision = 0
  @State private var refreshing = false
  @State private var legacyFrames = false
  @State private var streamRevision = 0
  @State private var inputTask: Task<Bool, Never>?
  @State private var pendingInputs = 0
  @State private var inputEpoch = UUID()
  @State private var keyboard = false
  @State private var clipboard = false
  @State private var inputControls = false
  @State private var help = false
  private var viewerFailure: String? { statusFailure ?? frameFailure }
  private var takeover: Bool { status["humanTakeover"].bool }
  private var working: Bool { busy || pendingInputs > 0 }
  private var path: String { "/api/v0/bots/\(API.segment(bot.id))/screen" }
  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        ChromeButton(title: "Done", symbol: "chevron.left") { Task { await close() } }
          .disabled(working)
        BotGlyph(color: Color(hex: bot.color), kind: bot.icon, size: 25)
        Text(bot.name).font(.body.weight(.medium)).lineLimit(1)
          .accessibilityValue(takeover ? "You have control" : "Watching")
        Spacer(minLength: 0)
        ChromeButton(title: "Computer help", symbol: "questionmark") { help = true }
        if hasFrame {
          Menu {
            Button(
              takeover ? "Give back control" : "Take control",
              systemImage: takeover ? "arrow.uturn.backward" : "hand.point.up.left"
            ) {
              keyboard = false
              Task { await setTakeover(!takeover) }
            }
            Button(paused ? "Resume view" : "Pause view", systemImage: paused ? "play" : "pause") {
              paused.toggle()
              if paused {
                keyboard = false
                inputEpoch = UUID()
              }
            }
            Button("Input controls", systemImage: "slider.horizontal.3") { inputControls = true }
          } label: {
            Image(systemName: "ellipsis").font(.system(size: 21))
              .frame(width: 44, height: 44).nativeGlass()
          }.buttonStyle(.plain).accessibilityLabel("Computer options").disabled(working)
        }
      }.padding(.horizontal, 18).padding(.top, 6).padding(.bottom, 10)
      ComputerVideo(
        frames: frames,
        remoteSize: CGSize(
          width: max(1, status["width"].int), height: max(1, status["height"].int)),
        interactive: takeover && !busy && viewerFailure == nil && !paused,
        trackpad: trackpad, showStarting: failure == nil && viewerFailure == nil
      ) { body in Task { await action(body) } }
      if let viewerFailure {
        VStack(alignment: .leading, spacing: 8) {
          if hasFrame { Text("Showing the last received screen").font(.caption) }
          InlineFailure(message: viewerFailure) {
            streamRevision += 1
            Task { await refreshFrame() }
          }
        }.padding(16).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18))
          .padding(.horizontal, 18)
      }
      if let failure { InlineFailure(message: failure).padding(18) }
      if hasFrame {
        HStack {
          ChromeButton(title: "Clipboard", symbol: "list.clipboard") {
            keyboard = false
            clipboard = true
          }
          Spacer()
          if paused { Text("View paused").font(.caption).foregroundStyle(.secondary) }
          ChromeButton(
            title: keyboard ? "Hide computer keyboard" : "Show computer keyboard",
            symbol: keyboard ? "keyboard.chevron.compact.down" : "keyboard"
          ) {
            Task {
              if !takeover { await setTakeover(true) }
              if takeover { keyboard.toggle() }
            }
          }.disabled(working || paused || viewerFailure != nil)
        }.padding(.horizontal, keyboard ? 18 : 30).padding(.top, 14).padding(.bottom, 12)
      }
    }.background(Color.black.ignoresSafeArea()).foregroundStyle(.white).preferredColorScheme(.dark)
      .background {
        ComputerKeyboard(active: keyboard && takeover && !paused && viewerFailure == nil) { body in
          Task { await action(body) }
        }.frame(width: 1, height: 1).accessibilityHidden(true)
      }
      .sheet(isPresented: $clipboard) { clipboardSheet }
      .sheet(isPresented: $inputControls) { controlsSheet }
      .alert("Using the computer", isPresented: $help) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(
          "Use the keyboard or choose Take control in the menu to pause the bot and interact. Tap to click, drag to move, or hold to right-click. Use two fingers to scroll. Closing this screen returns control to the bot."
        )
      }
      .onChange(of: takeover) { _, active in if !active { keyboard = false } }
      .interactiveDismissDisabled(takeover)
      .task(id: scenePhase) {
        guard scenePhase == .active else {
          if takeover { _ = await release() }
          return
        }
        while !Task.isCancelled {
          if !working, takeover, Date().timeIntervalSince(heartbeat) >= 20 {
            await setTakeover(true)
          }
          if !paused { await refreshFrame(includeImage: legacyFrames) }
          do { try await Task.sleep(for: .seconds(1)) } catch { return }
        }
      }
      .task(id: "\(scenePhase)-\(paused)-\(streamRevision)") {
        guard scenePhase == .active, !paused, !legacyFrames, let api = store.api else { return }
        while !Task.isCancelled {
          do {
            for try await data in api.computerFrames(path + "/stream") {
              try Task.checkCancellation()
              guard let image = UIImage(data: data) else {
                throw APIError("The computer did not return an image.")
              }
              frames.image = image
              if !hasFrame { hasFrame = true }
              if frameFailure != nil { frameFailure = nil }
            }
          } catch {
            guard !Task.isCancelled else { return }
            if let error = error as? APIError, error.status == 404 || error.status == 501 {
              legacyFrames = true
              await refreshFrame()
              return
            }
            frameFailure = UserFacingError.message(error)
            if (error as? APIError)?.unauthorized == true {
              store.handle(error)
              return
            }
          }
          do { try await Task.sleep(for: .seconds(2)) } catch { return }
        }
      }
      .onDisappear {
        inputEpoch = UUID()
        if handoffID != nil, !finishedHandoff { Task { _ = await finishHandoff("dismiss") } }
        if takeover, let api = store.api {
          Task {
            _ = try? await api.request(
              path + "/takeover", method: "POST", body: .object(["active": .bool(false)]))
          }
        }
      }
  }
  private var clipboardSheet: some View {
    NavigationStack {
      Form {
        Section("Send text to the computer") {
          TextField("Type on the computer", text: $text, axis: .vertical).lineLimit(4...12)
            .accessibilityIdentifier("computer-text")
          PasteButton(payloadType: String.self) { values in text += values.joined(separator: "\n") }
          if let failure { InlineFailure(message: failure) }
          Button("Type") {
            let value = text
            Task {
              if !takeover { await setTakeover(true) }
              if await action(["action": .string("type"), "text": .string(value)]) {
                text = ""
                clipboard = false
              }
            }
          }.disabled(
            text.isEmpty || text.count > 10_000 || working || paused || viewerFailure != nil)
        }
      }.navigationTitle("Clipboard").navigationBarTitleDisplayMode(.inline)
        .toolbar { Button("Close clipboard") { clipboard = false }.disabled(working) }
    }.presentationDetents([.medium, .large])
  }
  private var controlsSheet: some View {
    NavigationStack {
      Form {
        Section {
          Picker("Input mode", selection: $trackpad) {
            Text("Touch").tag(false)
            Text("Trackpad").tag(true)
          }.pickerStyle(.segmented)
          Text(
            trackpad
              ? "Move the pointer by dragging. Tap to click; tap then drag to drag remotely."
              : "Tap to click, drag to move, and hold to right-click."
          )
          .font(.footnote).foregroundStyle(.secondary)
        }
        Section("Keys") {
          ForEach(["Return", "Tab", "Escape", "BackSpace", "Left", "Right"], id: \.self) { key in
            Button(key) {
              Task { await action(["action": .string("key"), "keys": .array([.string(key)])]) }
            }
          }
        }.disabled(!takeover || working || viewerFailure != nil || paused)
        Section("Apps and scrolling") {
          ForEach(["chromium", "thunar", "terminal"], id: \.self) { app in
            let title: String =
              app == "chromium" ? "Browser" : (app == "thunar" ? "Files" : "Terminal")
            Button(title) { sendInput(["action": .string("open_app"), "app": .string(app)]) }
          }
          Button("Scroll up") {
            Task { await action(["action": .string("scroll"), "deltaY": .number(-3)]) }
          }
          Button("Scroll down") {
            Task { await action(["action": .string("scroll"), "deltaY": .number(3)]) }
          }
        }.disabled(!takeover || working || viewerFailure != nil || paused)
      }.navigationTitle("Input controls").navigationBarTitleDisplayMode(.inline)
        .toolbar { Button("Close input controls") { inputControls = false } }
    }.presentationDetents([.medium, .large])
  }
  func sendInput(_ body: [String: JSON]) { Task { await action(body) } }
  func close() async {
    keyboard = false
    if handoffID != nil {
      if await finishHandoff("complete") { dismiss() }
    } else if takeover {
      if await release() { dismiss() }
    } else {
      dismiss()
    }
  }
  func finishHandoff(_ action: String) async -> Bool {
    guard let handoffID, !finishedHandoff else { return true }
    guard !busy else { return false }
    busy = true
    defer { busy = false }
    do {
      let result = try await store.request(
        "/api/v0/channel-messages/\(API.segment(handoffID))/computer-handoff", method: "POST",
        body: .object([
          "action": .string(action),
          "clientId": .string(finishRequestID + "-" + action),
        ]))
      guard result["accepted"] != .bool(false) else {
        throw APIError("Computer control could not be returned. Please try again.")
      }
      if let message = try? result["message"].decode(Message.self) {
        store.merge([message], channel: message.channelId)
        store.persist()
      }
      NativeHaptics.play(.success, source: "computer.handoff-finish")
      finishedHandoff = true
      return true
    } catch {
      NativeHaptics.failure(error, source: "computer.handoff-finish")
      failure = UserFacingError.message(error)
      return false
    }
  }
  func refreshFrame(includeImage: Bool = true) async {
    guard !refreshing, let api = store.api else { return }
    refreshing = true
    let revision = controlRevision
    defer { refreshing = false }
    do {
      let next = try await store.request(path)
      statusFailure = nil
      if next["state"].string == "starting" || next["state"].string == "creating" {
        if revision == controlRevision { status = next }
        frameFailure = nil
        return
      }
      var image: UIImage?
      if includeImage {
        let (data, _) = try await api.raw(
          path + "/frame", query: ["v": String(Date().timeIntervalSince1970)])
        try Task.checkCancellation()
        guard let decoded = UIImage(data: data) else {
          throw APIError("The computer did not return an image.")
        }
        image = decoded
      }
      // A frame started before a control action must not overwrite its newer lease.
      if revision == controlRevision {
        if takeover && !next["humanTakeover"].bool { inputEpoch = UUID() }
        if status != next { status = next }
      }
      if let image {
        frames.image = image
        hasFrame = true
        frameFailure = nil
      }
    } catch {
      if !Task.isCancelled {
        statusFailure = UserFacingError.message(error)
        if (error as? APIError)?.unauthorized == true { store.handle(error) }
      }
    }
  }
  func setTakeover(_ active: Bool) async {
    guard !busy, let api = store.api else { return }
    inputEpoch = UUID()
    controlRevision += 1
    busy = true
    defer { busy = false }
    do {
      status = try await store.request(
        path + "/takeover", method: "POST", body: .object(["active": .bool(active)]))
      heartbeat = Date()
      if active && scenePhase != .active {
        status = try await api.request(
          path + "/takeover", method: "POST", body: .object(["active": .bool(false)]))
      }
      failure = nil
    } catch {
      failure = UserFacingError.message(error)
      if (error as? APIError)?.unauthorized == true { store.handle(error) }
    }
  }
  func release() async -> Bool {
    await setTakeover(false)
    return !takeover
  }
  @discardableResult func action(_ body: [String: JSON]) async -> Bool {
    guard takeover, !busy, viewerFailure == nil, !paused, store.api != nil else { return false }
    let previous = inputTask
    let epoch = inputEpoch
    controlRevision += 1
    pendingInputs += 1
    // Keep collecting gestures while the network is busy, preserving their arrival order.
    // A failed input or a control change invalidates the rest of the queue.
    let task = Task { @MainActor in
      if let previous { _ = await previous.value }
      guard epoch == inputEpoch, takeover, !paused, viewerFailure == nil else { return false }
      do {
        let next = try await store.request(path + "/actions", method: "POST", body: .object(body))
        guard epoch == inputEpoch else { return false }
        if status != next { status = next }
        failure = nil
        return true
      } catch {
        guard epoch == inputEpoch else { return false }
        inputEpoch = UUID()
        failure = UserFacingError.message(error)
        if (error as? APIError)?.unauthorized == true { store.handle(error) }
        return false
      }
    }
    inputTask = task
    let accepted = await task.value
    pendingInputs -= 1
    if pendingInputs == 0 { inputTask = nil }
    return accepted
  }
}

@MainActor @Observable private final class ComputerFrames {
  var image: UIImage?
}

/// Frame observation stays inside the surface. Menus, sheets and controls do not
/// participate in the 15fps image update cycle.
private struct ComputerVideo: View {
  let frames: ComputerFrames
  let remoteSize: CGSize
  let interactive: Bool
  let trackpad: Bool
  let showStarting: Bool
  let action: ([String: JSON]) -> Void
  var body: some View {
    GeometryReader { geometry in
      ZStack {
        if let image = frames.image {
          let ratio = remoteSize.width / remoteSize.height
          ComputerSurface(
            image: image, remoteSize: remoteSize,
            interactive: interactive, trackpad: trackpad, action: action
          )
          .frame(
            width: min(geometry.size.width, geometry.size.height * ratio),
            height: min(geometry.size.height, geometry.size.width / ratio))
        } else if showStarting {
          VStack(spacing: 14) {
            ProgressView().tint(.gray)
            Text("Starting desktop…").font(.subheadline)
          }
        }
      }.frame(width: geometry.size.width, height: geometry.size.height)
    }
  }
}
