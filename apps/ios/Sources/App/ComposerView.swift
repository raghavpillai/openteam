import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ComposerView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  @VoiceMotionPreference private var reduceMotion
  let channel: Channel
  var draftKey: String? = nil
  var threadRootID: String? = nil
  var replyRootID: String? = nil
  var focusOnAppear = false
  @State private var hasAppeared = false
  var focusRequest: UUID? = nil
  private var focusedReply: Bool { threadRootID != nil || replyRootID != nil }
  private var key: String { draftKey ?? channel.id }
  @State private var photos: [PhotosPickerItem] = []
  @State private var photoLibrary = false
  @State private var files = false
  @State private var camera = false
  @State private var uploading = false
  @StateObject private var memo = VoiceMemoController()
  /// The idle pill's height, where the gooey merge starts from.
  @State private var pillHeight: CGFloat = 44
  @State private var pluginMentions: [JSON] = []
  @FocusState private var focused: Bool
  // Focus arrives before the keyboard is ready, especially on its first launch.
  // Changing the safe-area inset then makes history jump before the keyboard moves.
  @State private var keyboardPresented = false
  private var draft: Draft { store.draft(key) }
  private var attachmentCount: Int { draft.attachments.count + (draft.stagedFiles?.count ?? 0) }
  private var text: Binding<String> {
    Binding(
      get: { draft.text },
      set: { value in
        var d = draft
        d.text = value
        d.widgetResponse = nil
        store.saveDraft(d, channel: key)
      })
  }
  private var transcriptionConfigured: Bool {
    store.state.bootstrap?.runtime["transcription"].string == "configured"
  }
  /// The trailing slot shows Send once there is something to send, the mic otherwise.
  private var hasContent: Bool {
    !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attachmentCount > 0
  }
  var body: some View {
    VStack(spacing: 0) {
      messageControls
    }.padding(.horizontal, keyboardPresented ? 18 : 30).padding(.top, 4)
      .padding(.bottom, keyboardPresented ? 18 : -4)
      // The voice glow rises from the bottom of the screen, behind the composer.
      .background(alignment: .bottom) {
        GeometryReader { composer in
          // Safe-area insets can be consumed by the floating bars. Measure against the
          // actual window, so the shader’s rounded bottom follows the phone’s edge.
          let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow)
          let frame = composer.frame(in: .global)
          let bottom = window?.bounds.maxY ?? frame.maxY
          let height = window?.bounds.height ?? composer.size.height
          VoiceGlowBackdrop(memo: memo)
            .frame(width: composer.size.width, height: height)
            .position(x: composer.size.width / 2,
              y: composer.size.height + max(0, bottom - frame.maxY) - height / 2)
        }
      }
      .background {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--trace-composer-latency") {
          ComposerLatencyProbe()
        }
        #endif
      }
      .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { note in
        if focused {
          ChatKeyboardMotion.update(note, reduceMotion: reduceMotion) { keyboardPresented = true }
        }
      }
      .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { note in
        ChatKeyboardMotion.update(note, reduceMotion: reduceMotion) { keyboardPresented = false }
      }
      .animation(
        reduceMotion ? nil : .timingCurve(0.23, 1, 0.32, 1, duration: 0.24),
        value: draft.text.isEmpty
      )
      .task(id: channel.id) {
        if let botID = store.bot(for: channel)?.id ?? channel.members.first?.botId {
          do {
            pluginMentions = try await store.request(
              "/api/v0/plugins/composer", query: ["botId": botID])["items"].array
          } catch { pluginMentions = [] }
        }
      }
      .onChange(of: draft.replyTo) { _, id in if id != nil && !focusOnAppear { focused = true } }
      .onChange(of: focusRequest) { _, _ in focused = true }
      .background(ComposerFocusLifecycle {
        if focusOnAppear && !hasAppeared { focused = true }
        hasAppeared = true
      }.frame(width: 0, height: 0))
      .photosPicker(
        isPresented: $photoLibrary, selection: $photos,
        maxSelectionCount: max(1, 6 - attachmentCount), matching: .images
      )
      .fileImporter(
        isPresented: $files, allowedContentTypes: [.item], allowsMultipleSelection: true
      ) { result in
        switch result {
        case .success(let urls):
          Task {
            if urls.count > max(0, 6 - attachmentCount) {
              NativeHaptics.play(.error, source: "composer.attachment-limit")
              store.error =
                "You can attach up to six files. The first available files have been kept."
            }
            for url in urls.prefix(max(0, 6 - attachmentCount)) {
              let access = url.startAccessingSecurityScopedResource()
              defer { if access { url.stopAccessingSecurityScopedResource() } }
              do {
                let mime =
                  UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                  ?? "application/octet-stream"
                if let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                  try AttachmentLimits.validate(byteCount: size, mimeType: mime)
                }
                try await upload(Data(contentsOf: url), name: url.lastPathComponent, mime: mime)
              } catch {
                NativeHaptics.failure(error, source: "composer.error")
                store.handle(error)
                break
              }
            }
          }
        case .failure(let error):
          NativeHaptics.failure(error, source: "composer.error")
          store.handle(error)
        }
      }
      .onChange(of: photos) { _, items in
        Task {
          for item in items.prefix(max(0, 6 - attachmentCount)) {
            do {
              if let data = try await item.loadTransferable(type: Data.self) {
                let type = item.supportedContentTypes.first ?? .jpeg
                try await upload(
                  data, name: "Photo.\(type.preferredFilenameExtension ?? "jpg")",
                  mime: type.preferredMIMEType ?? "image/jpeg")
              }
            } catch {
              NativeHaptics.failure(error, source: "composer.error")
              store.handle(error)
              break
            }
          }
          photos = []
        }
      }
      .sheet(isPresented: $camera) {
        CameraPicker { image in
          camera = false
          if let data = image?.jpegData(compressionQuality: 0.9) {
            Task {
              do { try await upload(data, name: "Camera.jpg", mime: "image/jpeg") } catch {
                NativeHaptics.failure(error, source: "composer.error")
                store.handle(error)
              }
            }
          }
        }
      }
      .onChange(of: scenePhase) { _, phase in if phase == .background { memo.suspend() } }
      // Recording frees the keyboard (the glow sits at the bottom of the screen) and the
      // hidden draft must not take typing.
      .onChange(of: memo.phase) { _, phase in
        if phase == .holding || phase == .locked || phase == .review { focused = false }
      }
      .task(id: key) { configureVoice() }
      .onDisappear {
        focused = false
        store.flushPersistence()
        memo.tearDown()
      }
  }
  private var messageControls: some View {
    let bar = memo.showsBar
    return HStack(alignment: .bottom, spacing: 10) {
      NativeAttachmentMenu(
        enabled: !uploading,
        attachmentsEnabled: attachmentCount < 6,
        // SwiftUI draws the persistent + → trash symbol below. UIKit keeps the menu target.
        color: .clear,
        photos: { photoLibrary = true }, files: { files = true }, camera: { camera = true },
        voice: (!draft.text.isEmpty || attachmentCount > 0) && transcriptionConfigured
          ? { startLockedRecording() } : nil
      ).frame(width: 44, height: 44)
        .allowsHitTesting(!bar).accessibilityHidden(bar)
      VStack(spacing: 0) {
        if !focusedReply, let reply = draft.replyTo {
          HStack(spacing: 7) {
            Image(systemName: "arrowshape.turn.up.left").font(.system(size: 12))
            Text(store.messages(channel.id).first { $0.id == reply }?.content ?? "Message").font(
              .system(size: 13)
            ).lineLimit(1)
            Spacer(minLength: 0)
            Button {
              var d = draft
              d.replyTo = nil
              d.isFork = false
              store.saveDraft(d, channel: key)
            } label: {
              Image(systemName: "xmark").font(.system(size: 11, weight: .medium)).frame(
                width: 28, height: 28)
            }.buttonStyle(.plain).accessibilityLabel("Cancel reply")
          }.foregroundStyle(NativePalette.muted).padding(.leading, 9).padding(.trailing, 2).frame(
            height: 31
          ).background(NativePalette.surface, in: Capsule()).padding(.horizontal, 6).padding(
            .top, 5)
        }
        if attachmentCount > 0 {
          ScrollView(.horizontal) {
            HStack {
              ForEach(draft.stagedFiles ?? []) { file in
                HStack {
                  Image(systemName: file.mimeType.hasPrefix("image/") ? "photo" : "doc")
                  Text(file.fileName).lineLimit(1)
                  Button("Remove " + file.fileName, systemImage: "xmark.circle.fill") {
                    store.removeStagedFile(file, channel: key)
                  }.labelStyle(.iconOnly)
                }.font(.caption).padding(10).background(NativePalette.surface, in: Capsule())
              }
              ForEach(draft.attachments) { asset in
                HStack {
                  Image(systemName: asset.kind == "image" ? "photo" : "doc")
                  Text(asset.fileName).lineLimit(1)
                  Button("Remove " + asset.fileName, systemImage: "xmark.circle.fill") {
                    var d = draft
                    d.attachments.removeAll { $0.id == asset.id }
                    store.saveDraft(d, channel: key)
                  }.labelStyle(.iconOnly)
                }.font(.caption).padding(10).background(NativePalette.surface, in: Capsule())
              }
            }.padding(8)
          }
        }
        if !mentions.isEmpty {
          ScrollView(.horizontal) {
            HStack {
              ForEach(mentions, id: \.self) { option in
                Button(option["label"].string) { chooseMention(option) }.buttonStyle(.bordered)
              }
            }.padding(8)
          }
        }
        TextField(
          "", text: text,
          prompt: Text((focusedReply ? "Reply " : channel.isGroup ? "Message " : "Ask ") + channel.name)
            .foregroundStyle(NativePalette.chatFaint),
          axis: .vertical
        )
        .font(.body).lineLimit(1...8).focused($focused).tint(NativePalette.chatInsertion)
        .padding(.leading, 16).padding(.trailing, 48)
        .padding(.vertical, text.wrappedValue.contains("\n") ? 7 : 11)
        .frame(minHeight: 44).accessibilityIdentifier(
          focusedReply ? "thread-message-input" : "message-input"
        )
        .contentShape(Rectangle())
        // Padding needs separate targets from the editable content and the
        // trailing send/voice control.
        .overlay {
          VStack(spacing: 0) {
            focusPadding.frame(height: text.wrappedValue.contains("\n") ? 7 : 11)
            Spacer(minLength: 0).allowsHitTesting(false)
            focusPadding.frame(height: text.wrappedValue.contains("\n") ? 7 : 11)
          }.overlay(alignment: .leading) { focusPadding.frame(width: 16) }
        }
        .overlay(alignment: .bottomTrailing) {
          // The visible pill is 36 × 28; its separate 44-point hit area keeps
          // sending/recording reachable without changing the reference inset.
          trailingAction.padding(.trailing, 5)
        }
        if uploading {
          HStack {
            LoadingOrb(size: 16).accessibilityHidden(true)
            Text("Preparing attachment…").font(.caption)
            Spacer()
          }.padding(8)
        }
      }
      // The draft stays mounted under the recording bar, so cancelling restores it untouched.
      .opacity(bar ? 0 : 1)
      // Reveal the draft as the glass opens; the shared mask keeps every line
      // inside it instead of leaving an empty expanded capsule during a delay.
      .animation(reduceMotion ? .easeInOut(duration: 0.2)
        : bar ? .easeOut(duration: 0.1) : .easeIn(duration: 0.18), value: bar)
      .allowsHitTesting(!bar).accessibilityHidden(bar)
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
        if !memo.showsBar { pillHeight = height }
      }
      .clipShape(VoiceComposerShape(progress: bar ? 1 : 0, pillHeight: Double(pillHeight), contentInset: 54))
      .frame(height: bar ? VoiceBar.height : nil, alignment: .bottom)
      .foregroundStyle(NativePalette.text)
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { memo.barWidth = Double($0) }
    // One persistent glass effect owns the message capsule in every phase. Fading
    // between separate glass effects leaves two refractive rims, even at rest.
    .background(alignment: .bottom) {
      VoiceBarSurface(progress: bar ? 1 : 0, pillHeight: Double(pillHeight))
    }
    .overlay(alignment: .bottom) {
      VoiceBarContent(memo: memo)
        .clipShape(VoiceComposerShape(progress: bar ? 1 : 0, pillHeight: Double(pillHeight)))
    }
    .overlay(alignment: .bottomLeading) { VoiceAttachmentMorph(memo: memo) }
    .overlay(alignment: .top) {
      ZStack {
        if memo.phase == .holding {
          // Zero height pins the label's bottom 16 pt above the bar, clear of the glow.
          VoiceReleaseLabel(armed: memo.tracker.cancelArmed)
            .frame(height: 0, alignment: .bottom).offset(y: -16)
            .transition(.opacity.combined(with: .offset(y: reduceMotion ? 0 : 6)))
        }
      }
    }
    .overlay(alignment: .bottomTrailing) {
      ZStack(alignment: .bottomTrailing) {
        // The lock status sits above Send for the whole recording: open while holding, closed
        // (and inert) once locked.
        if memo.phase == .holding || memo.phase == .locked || memo.phase == .review || memo.lockFlash {
          VoiceLockCapsule(memo: memo)
            // Centred over Send (the capsule is 40 pt wide).
            .offset(x: -(VoiceBar.inset + VoiceBar.button / 2 - 20), y: -(VoiceBar.height + 12))
            .transition(reduceMotion ? .opacity
              : .opacity.combined(with: .scale(scale: 0.6, anchor: .bottom)).combined(with: .offset(y: 10)))
        }
      }
      .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.8), value: memo.lockFlash)
    }
    .overlay(alignment: .bottomTrailing) {
      VoiceKnob(memo: memo, available: !hasContent, enabled: transcriptionConfigured && !uploading)
    }
    .overlay(alignment: .topTrailing) {
      ZStack {
        if let hint = memo.hint {
          // A zero-height frame pins the bubble's bottom 10 pt above the composer.
          VoiceHintBubble(text: hint)
            .frame(height: 0, alignment: .bottom).offset(y: -10)
            .transition(reduceMotion ? .opacity
              : .opacity.combined(with: .scale(scale: 0.9, anchor: .bottomTrailing)).combined(with: .offset(y: 6)))
        }
      }.animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.28, dampingFraction: 0.8),
        value: memo.hint)
    }
    // Voice phases change without withAnimation (see VoiceMemoController.transition);
    // the whole composer morphs here instead.
    .animation(VoiceMemoController.motion(reduceMotion: reduceMotion), value: memo.phase)
  }
  private var focusPadding: some View {
    Color.clear.contentShape(Rectangle()).onTapGesture { focused = true }
  }
  private var mentionToken: String? {
    let token = text.wrappedValue.components(separatedBy: .whitespacesAndNewlines).last ?? ""
    return token.first == "@" || token.first == "/" ? token : nil
  }
  private var mentions: [JSON] {
    guard let token = mentionToken else { return [] }
    var options = pluginMentions
    if channel.isGroup {
      options += [
        .object([
          "id": .string("everyone"), "label": .string("Everyone"), "handle": .string("everyone"),
          "trigger": .string("@"),
        ])
      ]
      options += store.bots.filter { bot in channel.members.contains { $0.botId == bot.id } }.map {
        .object([
          "id": .string($0.id), "label": .string($0.name),
          "handle": .string(
            $0.name.components(separatedBy: .whitespacesAndNewlines).joined().lowercased()),
          "trigger": .string("@"),
        ])
      }
    }
    let query = String(token.dropFirst()).lowercased()
    return Array(
      options.filter {
        $0["trigger"].string == String(token.prefix(1))
          && (query.isEmpty || $0["handle"].string.lowercased().contains(query)
            || $0["label"].string.lowercased().contains(query))
      }.prefix(4))
  }
  private func chooseMention(_ option: JSON) {
    guard let token = mentionToken else { return }
    NativeHaptics.play(.selection, source: "composer.mention")
    text.wrappedValue =
      String(text.wrappedValue.dropLast(token.count)) + option["trigger"].string
      + option["handle"].string + " "
    focused = true
  }
  @ViewBuilder var trailingAction: some View {
    if hasContent {
      Button {
        Task { await store.enqueue(channel, draftKey: key, threadRootID: threadRootID, replyRootID: replyRootID) }
      } label: {
        Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold))
          .foregroundStyle(NativePalette.onPrimary).frame(width: 36, height: 28).background(
            NativePalette.text, in: Capsule()
          )
          .frame(width: 44, height: 44).contentShape(Rectangle())
      }.buttonStyle(ComposerSendStyle()).disabled(uploading).accessibilityLabel("Send")
        .accessibilityIdentifier(
          focusedReply ? "thread-send-button" : "send-button")
    }
    // Otherwise the mic: VoiceKnob, overlaid at this spot, owns the hold-to-record gesture.
  }
  /// The + menu path (there is a draft): straight to the hands-free bar.
  func startLockedRecording() {
    focused = false
    memo.startLocked()
  }
  /// The recording is transcribed, appended to the draft, and the draft is sent.
  private func configureVoice() {
    memo.transcribe = { url in
      guard let api = store.api else { return nil }
      let data = try Data(contentsOf: url)
      let (response, _) = try await api.raw(
        "/api/v0/transcriptions", method: "POST", data: data, contentType: "audio/mp4",
        timeout: 135)
      guard store.api?.baseURL == api.baseURL, store.api?.token == api.token else { return nil }
      let value = try JSONDecoder().decode(JSON.self, from: response)["text"].string
      guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw APIError(
          "No speech was found in this recording. You can try again or discard the voice note.")
      }
      return value
    }
    memo.deliver = { transcript in
      var d = draft
      d.text = VoiceMemoText.message(draft: d.text, transcript: transcript)
      d.widgetResponse = nil
      store.saveDraft(d, channel: key)
      // Like the Send button: the outbox owns delivery, so the bar never waits on the network.
      // One yield lets enqueue move the draft into the outbox before the composer reappears.
      Task { await store.enqueue(channel, draftKey: key, threadRootID: threadRootID, replyRootID: replyRootID) }
      await Task.yield()
    }
    memo.report = { error in store.handle(error) }
  }
  func upload(_ data: Data, name: String, mime: String) async throws {
    uploading = true
    defer { uploading = false }
    try store.stage(data, name: name, mime: mime, channel: key)
  }
}

/// The reference dims the entire send pill during a press, including its fill.
/// Keeping that feedback on the label avoids fading the surrounding glass.
private struct ComposerSendStyle: ButtonStyle {
  @VoiceMotionPreference private var reduceMotion
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.opacity(configuration.isPressed ? 0.75 : 1)
      .animation(
        reduceMotion || configuration.isPressed ? nil : .easeOut(duration: 0.08),
        value: configuration.isPressed)
  }
}

struct CameraPicker: UIViewControllerRepresentable {
  var completion: (UIImage?) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }
  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.delegate = context.coordinator
    return picker
  }
  func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
  final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate
  {
    let completion: (UIImage?) -> Void
    init(completion: @escaping (UIImage?) -> Void) { self.completion = completion }
    func imagePickerController(
      _ picker: UIImagePickerController,
      didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) { completion(info[.originalImage] as? UIImage) }
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { completion(nil) }
  }
}

/// A child presentation keeps the composer first responder and gives each menu
/// the same measured row geometry without UIKit choosing a different source inset.
private struct NativeAttachmentMenu: View {
  let enabled: Bool
  let attachmentsEnabled: Bool
  let color: Color
  let photos: () -> Void, files: () -> Void, camera: () -> Void
  var voice: (() -> Void)?
  private var actions: [NativeMenuAction] {
    var items: [NativeMenuAction] = [
      .init(title: "Attach Image", symbol: "photo.on.rectangle", enabled: attachmentsEnabled, action: photos),
      .init(title: "Take Photo", symbol: "camera",
        enabled: attachmentsEnabled && UIImagePickerController.isSourceTypeAvailable(.camera), action: camera),
      .init(title: "Choose File", symbol: "folder", enabled: attachmentsEnabled, action: files),
    ]
    // The mic becomes Send while drafting. Keep voice insertion reachable
    // without changing the empty composer's three attachment options.
    if let voice { items.append(.init(title: "Record voice note", symbol: "mic.fill", action: voice)) }
    return items
  }
  var body: some View {
    NativeActionMenu(symbol: "plus", pointSize: 16, title: "Attach",
      identifier: "attach-button", panelIdentifier: "attachment-menu-panel",
      hapticSource: "composer.attach", anchor: .aboveLeading,
      enabled: enabled && (attachmentsEnabled || voice != nil), color: color, actions: actions)
  }
}

struct NativeMenuAction {
  let title: String
  var symbol: String? = nil
  var enabled = true
  let action: () -> Void
}

enum NativeMenuAnchor { case aboveLeading, topTrailing }

struct NativeActionMenu: UIViewRepresentable {
  @Environment(\.isEnabled) private var environmentEnabled
  let symbol: String
  var pointSize: CGFloat = 17
  var darkTint: Double = 0.10
  let title: String
  let identifier: String
  let panelIdentifier: String
  let hapticSource: String
  var anchor: NativeMenuAnchor = .topTrailing
  var enabled = true
  var color: Color = NativePalette.text
  /// Present a system `UIMenu` (springs out of the button) instead of the
  /// custom panel. The composer keeps the panel so the keyboard stays up.
  var systemMenu = false
  let actions: [NativeMenuAction]

  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeUIView(context: Context) -> UIButton {
    let button = NativeMenuButton(type: .system)
    button.setImage(UIImage(systemName: symbol, withConfiguration:
      UIImage.SymbolConfiguration(pointSize: pointSize, weight: .regular)), for: .normal)
    button.accessibilityLabel = title
    button.accessibilityIdentifier = identifier
    let coordinator = context.coordinator
    if systemMenu {
      button.showsMenuAsPrimaryAction = true
      button.menuWillOpen = { [weak coordinator] in
        guard let coordinator else { return }
        NativeHaptics.play(.light, source: coordinator.hapticSource)
      }
      return button
    }
    button.removed = { [weak coordinator] in coordinator?.close(animated: false) }
    button.addAction(UIAction { [weak button, weak coordinator] _ in
      guard let button else { return }
      coordinator?.open(from: button)
    }, for: .touchUpInside)
    return button
  }
  func updateUIView(_ button: UIButton, context: Context) {
    button.isEnabled = enabled && environmentEnabled
    button.tintColor = UIColor(color)
    context.coordinator.actions = actions
    context.coordinator.darkTint = darkTint
    context.coordinator.anchor = anchor
    context.coordinator.panelIdentifier = panelIdentifier
    context.coordinator.hapticSource = hapticSource
    if systemMenu {
      button.menu = UIMenu(children: actions.map { item in
        UIAction(title: item.title, image: item.symbol.flatMap { UIImage(systemName: $0) },
          attributes: item.enabled ? [] : .disabled) { _ in item.action() }
      })
    }
    if !button.isEnabled { context.coordinator.close(animated: false) }
  }
  static func dismantleUIView(_ uiView: UIButton, coordinator: Coordinator) {
    coordinator.close(animated: false)
  }

  @MainActor final class Coordinator {
    var actions: [NativeMenuAction] = []
    var darkTint = 0.10
    var anchor = NativeMenuAnchor.topTrailing
    var panelIdentifier = ""
    var hapticSource = ""
    private var panel: NativeMenuController?
    func open(from button: UIButton) {
      guard panel == nil else { close(); return }
      var responder: UIResponder? = button
      while responder != nil && !(responder is UIViewController) { responder = responder?.next }
      guard var parent = responder as? UIViewController else { return }
      while let ancestor = parent.parent { parent = ancestor }
      let controller = NativeMenuController(source: button, actions: actions,
        anchor: anchor, identifier: panelIdentifier, darkTint: darkTint) { [weak self] index in
        guard let self else { return }
        let item = index.flatMap { self.actions.indices.contains($0) ? self.actions[$0] : nil }
        self.close(animated: item == nil)
        if let item, item.enabled { item.action() }
      }
      panel = controller
      parent.addChild(controller)
      controller.view.frame = parent.view.bounds
      controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      parent.view.addSubview(controller.view)
      controller.didMove(toParent: parent)
      controller.reveal()
      NativeHaptics.play(.light, source: hapticSource)
    }
    func close(animated: Bool = true) {
      guard let controller = panel else { return }
      panel = nil
      controller.hide(animated: animated)
    }
  }
}

private final class NativeMenuButton: UIButton {
  var removed: (() -> Void)?
  var menuWillOpen: (() -> Void)?
  override func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
    willDisplayMenuFor configuration: UIContextMenuConfiguration,
    animator: (any UIContextMenuInteractionAnimating)?) {
    super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
    menuWillOpen?()
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { removed?() }
  }
}

private struct NativeMenuContent: View {
  let actions: [NativeMenuAction]
  let identifier: String
  let darkTint: Double
  let choose: (Int) -> Void
  @ScaledMetric(relativeTo: .body) private var rowHeight = 42.0
  var body: some View {
    VStack(spacing: 0) {
      ForEach(actions.indices, id: \.self) { index in
        Button { choose(index) } label: {
          HStack(spacing: 14) {
            if let symbol = actions[index].symbol {
              Image(systemName: symbol).font(.system(size: 17)).frame(width: 22)
            }
            Text(actions[index].title).font(.body)
            Spacer(minLength: 0)
          }.padding(.horizontal, 28).frame(minHeight: rowHeight)
            .contentShape(Rectangle())
        }.buttonStyle(.plain).foregroundStyle(NativePalette.text)
          .disabled(!actions[index].enabled)
      }
    }.padding(.vertical, 10).frame(width: 250)
      .modifier(NativeGlass(radius: 32, darkTint: darkTint))
      .accessibilityIdentifier(identifier)
  }
}

/// Public UIKit containment provides outside-tap / Escape dismissal without
/// resigning the text field or changing its keyboard safe-area during opening.
private final class NativeMenuController: UIViewController {
  weak var source: UIView?
  let actions: [NativeMenuAction]
  let anchor: NativeMenuAnchor
  let identifier: String
  let darkTint: Double
  let choose: (Int?) -> Void
  private var hosting: UIHostingController<NativeMenuContent>!
  init(source: UIView, actions: [NativeMenuAction], anchor: NativeMenuAnchor,
    identifier: String, darkTint: Double, choose: @escaping (Int?) -> Void) {
    self.source = source; self.actions = actions; self.anchor = anchor
    self.identifier = identifier; self.darkTint = darkTint; self.choose = choose
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    NotificationCenter.default.addObserver(self, selector: #selector(escape),
      name: UIApplication.didEnterBackgroundNotification, object: nil)
    let outside = UIButton(type: .custom)
    outside.frame = view.bounds; outside.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    outside.accessibilityLabel = "Dismiss menu"
    outside.addAction(UIAction { [weak self] _ in self?.choose(nil) }, for: .touchUpInside)
    view.addSubview(outside)
    hosting = UIHostingController(rootView: NativeMenuContent(actions: actions,
      identifier: identifier, darkTint: darkTint) { [weak self] in self?.choose($0) })
    hosting.view.backgroundColor = .clear
    addChild(hosting); view.addSubview(hosting.view); hosting.didMove(toParent: self)
    view.accessibilityViewIsModal = true
  }
  deinit { NotificationCenter.default.removeObserver(self) }
  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    guard let source, source.window != nil else { choose(nil); return }
    let sourceFrame = source.convert(source.bounds, to: view)
    let size = hosting.sizeThatFits(in: CGSize(width: 250, height: view.bounds.height))
    let left: CGFloat
    let top: CGFloat
    switch anchor {
    case .aboveLeading:
      left = view.safeAreaInsets.left + 8
      let bottom = min(sourceFrame.maxY + 10, view.bounds.height - view.safeAreaInsets.bottom)
      top = max(view.safeAreaInsets.top, bottom - size.height)
    case .topTrailing:
      left = view.bounds.width - view.safeAreaInsets.right - 8 - size.width
      top = max(view.safeAreaInsets.top, sourceFrame.minY - 5)
    }
    hosting.view.bounds = CGRect(origin: .zero, size: size)
    hosting.view.center = CGPoint(x: left + size.width / 2, y: top + size.height / 2)
  }
  func reveal() {
    view.layoutIfNeeded()
    guard !UIAccessibility.isReduceMotionEnabled else { return }
    hosting.view.alpha = 0
    let trailing = anchor == .topTrailing
    hosting.view.transform = CGAffineTransform(translationX: trailing ? 8 : -8,
      y: trailing ? -8 : 8).scaledBy(x: 0.96, y: 0.96)
    UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseOut]) {
      self.hosting.view.alpha = 1; self.hosting.view.transform = .identity
    }
  }
  func hide(animated: Bool) {
    view.isUserInteractionEnabled = false
    let remove = {
      self.willMove(toParent: nil); self.view.removeFromSuperview(); self.removeFromParent()
    }
    guard animated && !UIAccessibility.isReduceMotionEnabled else { remove(); return }
    UIView.animate(withDuration: 0.16, animations: { self.hosting.view.alpha = 0 }) { _ in remove() }
  }
  override func accessibilityPerformEscape() -> Bool { choose(nil); return true }
  override var keyCommands: [UIKeyCommand]? {
    [UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(escape))]
  }
  @objc private func escape() { choose(nil) }
}

/// Focus only after the native push/pop completes. Focusing a returning page
/// during an interactive pop can leave SwiftUI's keyboard inset at zero.
private struct ComposerFocusLifecycle: UIViewControllerRepresentable {
  var appeared: () -> Void
  final class Controller: UIViewController {
    var appeared: () -> Void = {}
    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      appeared()
    }
  }
  func makeUIViewController(context: Context) -> Controller {
    let controller = Controller(); controller.appeared = appeared; return controller
  }
  func updateUIViewController(_ controller: Controller, context: Context) { controller.appeared = appeared }
}
