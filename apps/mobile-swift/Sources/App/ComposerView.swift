import AVFoundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ComposerView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  let channel: Channel
  var draftKey: String? = nil
  var threadRootID: String? = nil
  private var key: String { draftKey ?? channel.id }
  @State private var photos: [PhotosPickerItem] = []
  @State private var photoLibrary = false
  @State private var files = false
  @State private var camera = false
  @State private var uploading = false
  @State private var voice = VoiceRecorder()
  @State private var transcribing = false
  @State private var voiceText = ""
  @State private var voiceRange: Range<String.Index>?
  @State private var pluginMentions: [JSON] = []
  @FocusState private var focused: Bool
  private var draft: Draft { store.draft(key) }
  private var attachmentCount: Int { draft.attachments.count + (draft.stagedFiles?.count ?? 0) }
  private var text: Binding<String> {
    Binding(
      get: { draft.text },
      set: { value in
        var d = draft
        d.text = value
        store.saveDraft(d, channel: key)
      })
  }
  var body: some View {
    VStack(spacing: 0) {
      if voice.recording || voice.pendingURL != nil {
        recordingControls
      } else {
        messageControls
      }
    }.padding(.horizontal, focused ? 18 : 30).padding(.top, 4).padding(.bottom, focused ? 18 : -4)
      .task(id: channel.id) {
        if let botID = store.bot(for: channel)?.id ?? channel.members.first?.botId {
          do {
            pluginMentions = try await store.request(
              "/api/v0/plugins/composer", query: ["botId": botID])["items"].array
          } catch { pluginMentions = [] }
        }
      }
      .onChange(of: draft.replyTo) { _, id in if id != nil { focused = true } }
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
      .onChange(of: scenePhase) { _, phase in if phase != .active { _ = voice.stop() } }
      .onDisappear { voice.cancel() }
  }
  private var messageControls: some View {
    HStack(alignment: .bottom, spacing: 10) {
      NativeAttachmentMenu(
        enabled: !uploading && attachmentCount < 6,
        voiceEnabled: !transcribing && !voice.recording && voice.pendingURL == nil
          && store.state.bootstrap?.runtime["transcription"].string == "configured",
        color: NativePalette.text,
        photos: { photoLibrary = true }, files: { files = true }, camera: { camera = true },
        voice: startRecording
      ).frame(width: 44, height: 44).nativeGlass()
      VStack(spacing: 0) {
        if let reply = draft.replyTo {
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
          prompt: Text("Ask " + channel.name).foregroundStyle(NativePalette.muted),
          axis: .vertical
        )
        .font(.body).lineLimit(1...8).focused($focused)
        .padding(.leading, 16).padding(.trailing, 48)
        .padding(.vertical, text.wrappedValue.contains("\n") ? 7 : 11)
        .frame(minHeight: 44).accessibilityIdentifier(
          threadRootID == nil ? "message-input" : "thread-message-input"
        )
        .overlay(alignment: .bottomTrailing) {
          trailingAction.padding(.trailing, 9).padding(.bottom, 8)
        }
        if uploading || transcribing {
          HStack {
            ProgressView()
            Text(uploading ? "Preparing attachment…" : "Transcribing…").font(.caption)
            Spacer()
          }.padding(8)
        }
      }.nativeGlass().foregroundStyle(NativePalette.text)
    }
  }
  private var recordingControls: some View {
    HStack(spacing: 10) {
      Button {
        if voice.recording {
          _ = voice.stop()
        } else {
          NativeHaptics.play(.light, source: "composer.cancel-voice")
          voice.cancel()
        }
      } label: {
        Image(systemName: voice.recording ? "stop.fill" : "xmark")
          .font(.system(size: 19, weight: .semibold))
          .frame(maxWidth: .infinity).frame(height: 48).nativeGlass(radius: 28)
      }.accessibilityLabel(voice.recording ? "Stop recording" : "Discard recording")
      HStack(spacing: 9) {
        Text(String(format: "%d:%02d", Int(voice.elapsed) / 60, Int(voice.elapsed) % 60))
          .font(.system(size: 21, weight: .semibold)).monospacedDigit().fixedSize()
        HStack(spacing: 1.5) {
          ForEach(Array(voice.levels.enumerated()), id: \.offset) { _, level in
            Capsule().fill(NativePalette.muted).frame(width: 2, height: 4 + level * 17)
          }
        }.frame(width: 63, height: 24).clipped()
      }.padding(.horizontal, 14).frame(height: 48).fixedSize(horizontal: true, vertical: false)
        .nativeGlass(radius: 28)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(voice.recording ? "Recording voice note" : "Voice note ready")
        .accessibilityValue("\(Int(voice.elapsed)) seconds")
        .contextMenu {
          Button("Discard recording", role: .destructive) {
            NativeHaptics.play(.light, source: "composer.cancel-voice")
            voice.cancel()
          }
        }
      Button {
        Task { await transcribe() }
      } label: {
        Group {
          if transcribing {
            ProgressView().tint(NativePalette.onPrimary)
          } else {
            Image(systemName: "arrow.up").font(.system(size: 24, weight: .semibold))
          }
        }.frame(maxWidth: .infinity).frame(height: 48)
          .foregroundStyle(NativePalette.onPrimary).background(NativePalette.text, in: Capsule())
      }.accessibilityLabel(transcribing ? "Transcribing" : "Transcribe voice note")
    }.buttonStyle(.plain).foregroundStyle(NativePalette.text).disabled(transcribing)
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
    if !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attachmentCount > 0 {
      Button {
        Task { await store.enqueue(channel, draftKey: key, threadRootID: threadRootID) }
      } label: {
        Image(systemName: "arrow.up").font(.system(size: 17, weight: .semibold))
          .foregroundStyle(NativePalette.onPrimary).frame(width: 28, height: 28).background(
            NativePalette.text, in: Circle())
      }.buttonStyle(.plain).disabled(uploading).accessibilityLabel("Send").accessibilityIdentifier(
        threadRootID == nil ? "send-button" : "thread-send-button")
    } else if !store.activeRuns(channel.id).isEmpty {
      Button {
        Task {
          for run in store.activeRuns(channel.id) {
            await store.mutate("/api/v0/runs/\(API.segment(run.id))/cancel")
          }
        }
      } label: {
        Image(systemName: "stop.fill").font(.system(size: 10)).foregroundStyle(
          NativePalette.onPrimary
        ).frame(width: 28, height: 28).background(NativePalette.text, in: Circle())
      }.buttonStyle(.plain).accessibilityLabel("Stop")
    } else {
      Button {
        startRecording()
      } label: {
        Image(systemName: "mic.fill").font(.system(size: 17)).foregroundStyle(NativePalette.muted)
          .frame(width: 36, height: 28).background(NativePalette.muted.opacity(0.15), in: Capsule())
      }.buttonStyle(.plain).disabled(
        transcribing || voice.pendingURL != nil
          || store.state.bootstrap?.runtime["transcription"].string != "configured"
      ).accessibilityLabel("Record voice note")
    }
  }
  func startRecording() {
    voiceText = text.wrappedValue
    voiceRange = NativeTextSelection.range(matching: voiceText)
    focused = false
    Task {
      do { try await voice.start() } catch {
        NativeHaptics.failure(error, source: "composer.error")
        store.handle(error)
      }
    }
  }
  func upload(_ data: Data, name: String, mime: String) async throws {
    uploading = true
    defer { uploading = false }
    try store.stage(data, name: name, mime: mime, channel: key)
  }

  func transcribe() async {
    guard !transcribing, let url = voice.stop(), let api = store.api else { return }
    transcribing = true
    defer {
      transcribing = false
    }
    do {
      let data = try Data(contentsOf: url)
      let (response, _) = try await api.raw(
        "/api/v0/transcriptions", method: "POST", data: data, contentType: "audio/mp4")
      guard store.api?.baseURL == api.baseURL, store.api?.token == api.token else { return }
      let value = try JSONDecoder().decode(JSON.self, from: response)["text"].string
      guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw APIError(
          "No speech was found in this recording. You can try again or discard the voice note.")
      }
      if text.wrappedValue == voiceText, let voiceRange {
        text.wrappedValue.replaceSubrange(voiceRange, with: value)
      } else {
        text.wrappedValue += (text.wrappedValue.isEmpty ? "" : " ") + value
      }
      voice.cancel()
    } catch {
      NativeHaptics.failure(error, source: "composer.error")
      store.handle(error)
    }
  }
}

@MainActor @Observable
final class VoiceRecorder {
  var recording = false
  var pendingURL: URL?
  var elapsed: TimeInterval = 0
  var levels: [CGFloat] = Array(repeating: 0.2, count: 18)
  private var meter: Task<Void, Never>?
  private var recorder: AVAudioRecorder?
  private var starting = false
  private var generation = UUID()
  #if DEBUG && targetEnvironment(simulator)
    private var fixture: SimulatorVoiceFixture?
  #endif
  private var deadline: Task<Void, Never>?
  func start() async throws {
    guard !starting, !recording, pendingURL == nil else { return }
    starting = true
    defer { starting = false }
    let attempt = generation
    #if DEBUG && targetEnvironment(simulator)
      if ProcessInfo.processInfo.arguments.contains("--ui-testing"),
        ProcessInfo.processInfo.arguments.contains("--qa-synthetic-voice")
      {
        let capture = try SimulatorVoiceFixture()
        fixture = capture
        recording = true
        elapsed = 0
        levels = Array(repeating: 0, count: 18)
        meter = Task {
          while !Task.isCancelled, recording {
            do {
              let level = try capture.append()
              elapsed = capture.elapsed
              levels = Array((levels + [level]).suffix(18))
              try await Task.sleep(for: .milliseconds(100))
            } catch {
              _ = stop()
              return
            }
          }
        }
        return
      }
    #endif
    guard await AVAudioApplication.requestRecordPermission() else {
      throw APIError("Enable microphone access in iPhone Settings to record a voice note.")
    }
    guard attempt == generation, !Task.isCancelled else { return }
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
    try session.setActive(true)
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString + ".m4a")
    let r = try AVAudioRecorder(
      url: url,
      settings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 24000, AVNumberOfChannelsKey: 1,
        AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
      ])
    r.isMeteringEnabled = true
    guard r.record(forDuration: 300) else {
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      throw APIError("The microphone could not start recording.")
    }
    recorder = r
    recording = true
    elapsed = 0
    levels = Array(repeating: 0.2, count: 18)
    meter = Task {
      while !Task.isCancelled, recording {
        r.updateMeters()
        elapsed = r.currentTime
        levels.append(CGFloat(max(0, min(1, (r.averagePower(forChannel: 0) + 50) / 50))))
        levels = Array(levels.suffix(18))
        do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
      }
    }
    deadline = Task {
      try? await Task.sleep(for: .seconds(300))
      if !Task.isCancelled { _ = stop() }
    }
  }
  func stop() -> URL? {
    deadline?.cancel()
    meter?.cancel()
    if let recorder { elapsed = recorder.currentTime }
    recorder?.stop()
    recording = false
    var url = recorder?.url ?? pendingURL
    #if DEBUG && targetEnvironment(simulator)
      if let fixture {
        elapsed = fixture.elapsed
        url = fixture.url
        fixture.finish()
        self.fixture = nil
      }
    #endif
    pendingURL = url
    recorder = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    return url
  }
  func cancel() {
    generation = UUID()
    if let url = stop() { try? FileManager.default.removeItem(at: url) }
    pendingURL = nil
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

/// Observe UIKit's actual menu-presentation event. SwiftUI Menu consumes the
/// label's tap gesture, so a simultaneous TapGesture can silently miss feedback.
private struct NativeAttachmentMenu: UIViewRepresentable {
  let enabled: Bool, voiceEnabled: Bool
  let color: Color
  let photos: () -> Void, files: () -> Void, camera: () -> Void, voice: () -> Void
  func makeUIView(context: Context) -> UIButton {
    let button = UIButton(type: .system)
    button.setImage(
      UIImage(
        systemName: "plus",
        withConfiguration: UIImage.SymbolConfiguration(pointSize: 24, weight: .regular)),
      for: .normal)
    button.showsMenuAsPrimaryAction = true
    button.accessibilityLabel = "Attach"
    button.accessibilityIdentifier = "attach-button"
    button.addAction(
      UIAction { _ in NativeHaptics.play(.light, source: "composer.attach") },
      for: .menuActionTriggered)
    return button
  }
  func updateUIView(_ button: UIButton, context: Context) {
    button.isEnabled = enabled
    button.tintColor = UIColor(color)
    var actions = [
      UIAction(title: "Photo library", image: UIImage(systemName: "photo")) { _ in photos() },
      UIAction(title: "Files", image: UIImage(systemName: "doc")) { _ in files() },
    ]
    if UIImagePickerController.isSourceTypeAvailable(.camera) {
      actions.append(
        UIAction(title: "Camera", image: UIImage(systemName: "camera")) { _ in camera() })
    }
    actions.append(
      UIAction(
        title: "Record voice note", image: UIImage(systemName: "mic"),
        attributes: voiceEnabled ? [] : [.disabled]
      ) { _ in voice() })
    button.menu = UIMenu(children: actions)
  }
}
