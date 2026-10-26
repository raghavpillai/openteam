import AVFoundation
import Combine
import SwiftUI
import ThinkingOrbsKit
import UIKit
import VoiceGlowKit

// Voice memos, Discord style. Tap the mic: hands-free recording. Press and hold: release
// sends the transcript; while holding, slide left and release to cancel, or slide up to lock.
// The + button and the message pill merge (gooey) into one recording bar, and a voice glow
// rises from the bottom of the screen behind it. The draft stays untouched underneath.

/// Uses the device preference in production and the same code path for
/// deterministic reduced-motion simulator audits.
@propertyWrapper struct VoiceMotionPreference: DynamicProperty {
  @Environment(\.accessibilityReduceMotion) private var systemReducedMotion
  var wrappedValue: Bool { systemReducedMotion || VoiceMemoController.previewsReducedMotion }
}

/// Shared geometry of the recording bar.
enum VoiceBar {
  static let height: CGFloat = 64
  static let inset: CGFloat = 10
  static let button: CGFloat = 44
  /// The send (or cancel) button's centre, from the composer's bottom-trailing corner.
  static let sendCenter = CGPoint(x: -(inset + button / 2), y: -height / 2)
}

/// An `ObservableObject` rather than `@Observable` on purpose: Observation's one-shot tracking
/// could drop the invalidation of a view re-evaluated at the wrong moment (the knob became Send
/// while the composer kept its idle pill). `objectWillChange` is a standing subscription.
@MainActor
final class VoiceMemoController: ObservableObject {
  enum Phase: Equatable {
    /// The mic waits in the composer.
    case idle
    /// Finger down, microphone opening; the hold UI commits after `holdDelay`.
    case pressing
    /// Finger down, recording: release sends, slide left (and release) cancels, slide up locks.
    case holding
    /// Hands-free: the bar with trash, timer, waveform and send.
    case locked
    /// The trash animation, before the composer returns.
    case cancelling
    /// Uploading the recording; the transcript is sent when it arrives.
    case transcribing
    /// Transcription failed: the recording is kept for retry or discard.
    case review
  }

  @Published private(set) var phase: Phase = .idle
  let recorder = VoiceRecorder()
  @Published private(set) var tracker = VoiceHoldTracker(barWidth: 0)
  private var cancelResistance = VoiceCancelResistanceFeedback()
  @Published private(set) var hint: String?
  /// Bumped whenever a trash animation should play.
  @Published private(set) var trashes = 0
  /// The lock just closed: the capsule shows the shut lock before it leaves.
  @Published private(set) var lockFlash = false

  let thresholds = VoiceHoldThresholds()
  /// The composer's full width; sets the cancel distance for the next press.
  var barWidth: Double = 0
  /// Uploads a finished recording and returns its transcript, or nil when the result
  /// no longer applies (for example, the account changed while uploading).
  var transcribe: (@MainActor (URL) async throws -> String?)?
  /// Sends the draft with the transcript appended.
  var deliver: (@MainActor (String) async -> Void)?
  var report: (@MainActor (Error) -> Void)?

  private var touchStart: CGPoint?
  private var touchPhase: Phase = .idle
  private var holdStart: Date?
  private var processingStart = Date()
  private var lastGlowMotion: VoiceGlowMotion = .rest
  private var holdTask: Task<Void, Never>?
  private var startTask: Task<Void, Never>?
  private var hintTask: Task<Void, Never>?
  private var settleTask: Task<Void, Never>?
  private var flashTask: Task<Void, Never>?
  private var transcription: Task<Void, Never>?
  /// Identifies the press (or hands-free start) that asked for the microphone.
  private var recordingSession = UUID()

  /// The composer has become the recording bar.
  var showsBar: Bool { phase != .idle && phase != .pressing }
  var isRecording: Bool { phase == .holding || phase == .locked }
  var glowActive: Bool { phase == .holding || phase == .locked || phase == .transcribing }

  /// The composer animates phase changes with `.animation(motion, value: phase)`.
  // One spring owns the surface, layout and both controls. Independent springs
  // let the leading control outrun its glass in intermediate frames.
  static let morph = Animation.spring(response: 0.42, dampingFraction: 0.86)
  static func motion(reduceMotion: Bool) -> Animation {
    reduceMotion ? .easeInOut(duration: 0.2) : morph
  }
  /// Deterministic accessibility preview for simulator audits; release builds
  /// always follow the device setting.
  nonisolated static var previewsReducedMotion: Bool {
    #if DEBUG
      ProcessInfo.processInfo.arguments.contains("--ui-testing")
        && ProcessInfo.processInfo.arguments.contains("--qa-reduce-motion")
    #else
      false
    #endif
  }
  private var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled || Self.previewsReducedMotion }

  /// Groups one transition's changes. Deliberately not `withAnimation`: it first flushes
  /// pending changes (the meter updates the recorder every 100 ms), and a view re-evaluated by
  /// that flush can miss the phase change made right after it — the knob became Send while
  /// the bar kept its holding layout. The composer animates on `phase` instead.
  private func transition(_ change: () -> Void) { change() }

  // MARK: Touch

  func press(at point: CGPoint, enabled: Bool) {
    touchPhase = phase
    touchStart = point
    guard phase == .idle, enabled else { return }
    cancelResistance = VoiceCancelResistanceFeedback()
    NativeHaptics.prepareVoiceResistance()
    holdStart = nil
    hintTask?.cancel()
    transition {
      tracker = VoiceHoldTracker(barWidth: barWidth, thresholds: thresholds)
      hint = nil
      phase = .pressing
    }
    // Open the microphone right away so the first word isn't clipped.
    startRecorder()
    holdTask = Task { [weak self, delay = thresholds.holdDelay] in
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled, let self, phase == .pressing else { return }
      beginHolding { }
    }
  }

  func move(to point: CGPoint) {
    guard touchPhase == .idle, let start = touchStart, phase == .pressing || phase == .holding
    else { return }
    var next = tracker
    let wasArmed = tracker.cancelArmed
    let event = next.move(dx: point.x - start.x, dy: point.y - start.y)
    // A deliberate slide shows the recording UI without waiting out the hold delay.
    let starting = phase == .pressing && next.isSliding
    switch event {
    case .lock:
      if starting {
        holdTask?.cancel()
        holdStart = Date()
      }
      lock { tracker = next }
    case nil:
      let resistance = cancelResistance.move(next.cancelFeedbackProgress,
        time: ProcessInfo.processInfo.systemUptime)
      if next.cancelArmed != wasArmed {
        // A soft catch at full stretch, then a lighter release on backing off.
        if next.cancelArmed {
          NativeHaptics.voiceResistance(intensity: 0.65, source: "composer.voice-cancel-arm")
        } else {
          NativeHaptics.voiceResistance(intensity: 0.22, source: "composer.voice-cancel-disarm")
        }
      } else if !next.cancelArmed, let resistance {
        NativeHaptics.voiceResistance(intensity: resistance, source: "composer.voice-cancel-detent")
      }
      if starting { beginHolding { tracker = next } } else { tracker = next }
    }
  }

  func release(at point: CGPoint) {
    let began = touchPhase, start = touchStart
    touchStart = nil
    touchPhase = .idle
    switch began {
    case .idle:
      switch phase {
      case .pressing:
        // A tap: keep recording hands-free.
        holdTask?.cancel()
        holdStart = Date()
        NativeHaptics.play(.medium, source: "composer.voice-start")
        transition { phase = .locked }
      case .holding:
        let decision = thresholds.release(
          heldFor: holdStart.map { Date().timeIntervalSince($0) }, cancelArmed: tracker.cancelArmed)
        switch decision {
        case .lock: lock { }
        case .cancel:
          NativeHaptics.play(.warning, source: "composer.voice-cancel")
          trash { }
        case .send: send()
        }
      default:
        break  // Lifting the finger after a lock changes nothing.
      }
    case .locked, .review:
      if isTap(from: start, to: point) { send() }
    case .transcribing:
      if isTap(from: start, to: point) { cancelTranscription() }
    default:
      break
    }
  }

  /// The system took the touch (a permission prompt, a call, Control Center): never drop
  /// the recording; it carries on hands-free.
  func cancelTouch() {
    let began = touchPhase
    touchStart = nil
    touchPhase = .idle
    guard began == .idle, phase == .pressing || phase == .holding else { return }
    holdTask?.cancel()
    if holdStart == nil { holdStart = Date() }
    lock { }
  }

  private func isTap(from start: CGPoint?, to end: CGPoint) -> Bool {
    guard let start else { return true }
    return hypot(end.x - start.x, end.y - start.y) < 44
  }

  // MARK: Transitions

  /// Accessibility, keyboard and the + menu: start hands-free.
  func startLocked() {
    guard phase == .idle else { return }
    hintTask?.cancel()
    holdStart = Date()
    NativeHaptics.play(.medium, source: "composer.voice-start")
    transition {
      hint = nil
      phase = .locked
    }
    startRecorder()
  }

  private func beginHolding(_ alongside: () -> Void) {
    holdTask?.cancel()
    holdStart = Date()
    NativeHaptics.play(.medium, source: "composer.voice-start")
    transition {
      alongside()
      phase = .holding
    }
  }

  private func lock(_ alongside: () -> Void) {
    NativeHaptics.voiceLock(source: "composer.voice-lock")
    transition {
      alongside()
      lockFlash = true
      phase = .locked
    }
    flashTask?.cancel()
    flashTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(420))
      guard !Task.isCancelled else { return }
      self?.lockFlash = false
    }
  }

  /// The trash button in the bar.
  func discardRecording() {
    guard phase == .locked || phase == .review else { return }
    NativeHaptics.play(.warning, source: "composer.voice-discard")
    trash { }
  }

  private func trash(_ alongside: () -> Void) {
    holdTask?.cancel()
    transition {
      alongside()
      recorder.cancel()
      trashes += 1
      phase = .cancelling
    }
    settleTask?.cancel()
    settleTask = Task { [weak self, quick = reduceMotion] in
      try? await Task.sleep(for: .milliseconds(quick ? 250 : 880))
      guard !Task.isCancelled, let self, phase == .cancelling else { return }
      transition { phase = .idle }
    }
  }

  func send() {
    guard phase == .holding || phase == .locked || phase == .review else { return }
    var stopped: URL?
    let failure = "The microphone didn't start. Try again."
    transition {
      stopped = recorder.stop()
      if stopped == nil {
        // The microphone never opened, for example while it waited for permission.
        recorder.cancel()
        hint = failure
      }
      phase = stopped == nil ? .idle : .transcribing
    }
    guard let url = stopped else {
      announce(failure)
      return
    }
    NativeHaptics.play(.light, source: "composer.voice-send")
    processingStart = Date()
    transcription?.cancel()
    transcription = Task { [weak self] in
      guard let self, let transcribe else { return }
      do {
        let text = try await transcribe(url)
        guard !Task.isCancelled, phase == .transcribing, recorder.pendingURL == url else { return }
        if let text { await deliver?(text) }
        transition {
          recorder.cancel()
          phase = .idle
        }
      } catch {
        guard !Task.isCancelled, phase == .transcribing, recorder.pendingURL == url else { return }
        // Keep the recording so it can be retried or discarded.
        transition { phase = .review }
        NativeHaptics.failure(error, source: "composer.error")
        report?(error)
      }
    }
  }

  func cancelTranscription() {
    guard phase == .transcribing else { return }
    transcription?.cancel()
    transcription = nil
    NativeHaptics.play(.light, source: "composer.voice-cancel-transcription")
    transition {
      recorder.cancel()
      phase = .idle
    }
  }

  /// The app went to the background: keep what was recorded for review.
  func suspend() {
    touchStart = nil
    touchPhase = .idle
    switch phase {
    case .pressing:
      holdTask?.cancel()
      recorder.cancel()
      phase = .idle
    case .holding, .locked:
      if recorder.stop() != nil { phase = .review } else { recorder.cancel(); phase = .idle }
    default:
      break
    }
  }

  func tearDown() {
    for task in [holdTask, startTask, hintTask, settleTask, flashTask, transcription] { task?.cancel() }
    transcription = nil
    recorder.cancel()
    touchStart = nil
    touchPhase = .idle
    phase = .idle
    hint = nil
    lockFlash = false
  }

  private func startRecorder() {
    startTask?.cancel()
    let session = UUID()
    recordingSession = session
    startTask = Task { [weak self] in
      guard let self else { return }
      do {
        try await recorder.start()
        // The recording ended while the microphone was opening: close it again rather
        // than record in the background.
        let wanted = phase == .pressing || phase == .holding || phase == .locked
        if recordingSession != session || !wanted { recorder.cancel() }
      } catch {
        if recordingSession == session { startFailed(error) }
      }
    }
  }

  private func startFailed(_ error: Error) {
    holdTask?.cancel()
    hintTask?.cancel()
    touchStart = nil
    touchPhase = .idle
    let active = phase == .pressing || phase == .holding || phase == .locked
    transition {
      hint = nil
      if active {
        recorder.cancel()
        phase = .idle
      }
    }
    NativeHaptics.failure(error, source: "composer.error")
    report?(error)
  }

  // MARK: Hint

  /// Announces a hint set by a transition and dismisses it after a moment.
  private func announce(_ text: String) {
    UIAccessibility.post(notification: .announcement, argument: text)
    hintTask?.cancel()
    hintTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(Self.hintDuration))
      guard !Task.isCancelled else { return }
      self?.hint = nil
    }
  }

  private static var hintDuration: Double {
    #if DEBUG
      // UI tests wait for the app to idle before they can look; give them time to find it.
      if ProcessInfo.processInfo.arguments.contains("--ui-testing") { return 4 }
    #endif
    return 1.8
  }

  // MARK: Glow

  /// Sampled every frame by the glow; reads the recorder's meter directly.
  func glowLevel() -> Double {
    isRecording ? recorder.liveLevel() : 0
  }

  /// The processing sweep while transcribing; the voice glow at rest otherwise.
  func glowMotion() -> VoiceGlowMotion {
    // Preserve the last geometry while presence fades. Resetting offset/gather
    // on the first idle frame throws the fading beam across the phone.
    guard glowActive else { return lastGlowMotion }
    guard phase == .transcribing else { lastGlowMotion = .rest; return .rest }
    let frame = VoiceProcessingSweep.frame(elapsed: Date().timeIntervalSince(processingStart),
      reduceMotion: reduceMotion)
    let motion = VoiceGlowMotion(gather: frame.gather, offset: frame.offset, stretch: frame.stretch,
      heldLevel: frame.heldLevel)
    lastGlowMotion = motion
    return motion
  }
}

// MARK: - Recorder

@MainActor
final class VoiceRecorder: ObservableObject {
  @Published var recording = false
  @Published var pendingURL: URL?
  @Published var elapsed: TimeInterval = 0
  /// Recent levels (0…1), newest last, sampled every 100 ms.
  @Published var levels: [CGFloat] = []
  /// The latest sampled level.
  @Published var level: CGFloat = 0
  static let history = 80
  private var meter: Task<Void, Never>?
  private var recorder: AVAudioRecorder?
  private var starting = false
  private var generation = UUID()
  #if DEBUG && targetEnvironment(simulator)
    private var fixture: SimulatorVoiceFixture?
  #endif
  private var deadline: Task<Void, Never>?

  /// When the newest sample arrived; the waveform slides between samples from it.
  private(set) var lastSampleAt = Date.distantPast

  private func sample(_ value: CGFloat) {
    lastSampleAt = Date()
    level = min(1, max(0, value))
    levels.append(level)
    if levels.count > Self.history { levels.removeFirst(levels.count - Self.history) }
  }

  /// A fresh reading for the glow: the microphone's meter (the same recorder, never a
  /// second audio engine), or the fixture's latest sample.
  func liveLevel() -> Double {
    guard recording else { return 0 }
    if let recorder {
      recorder.updateMeters()
      return VoiceLevel.normalized(decibels: Double(recorder.averagePower(forChannel: 0)))
    }
    return Double(level)
  }

  func start() async throws {
    guard !starting, !recording, pendingURL == nil else { return }
    starting = true
    defer { starting = false }
    let attempt = generation
    #if DEBUG && targetEnvironment(simulator)
      if ProcessInfo.processInfo.arguments.contains("--ui-testing"),
        ProcessInfo.processInfo.arguments.contains("--qa-synthetic-voice")
      {
        var sourceURL: URL?
        if let raw = ProcessInfo.processInfo.environment["OPENTEAM_QA_VOICE_SOURCE"] {
          guard let source = URL(string: raw), source.scheme == "http",
            source.host == "127.0.0.1"
          else { throw APIError("QA speech source must be on loopback.") }
          let (download, response) = try await URLSession.shared.download(from: source)
          guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw APIError("QA speech could not be loaded.")
          }
          sourceURL = download
        }
        defer { if let sourceURL { try? FileManager.default.removeItem(at: sourceURL) } }
        guard attempt == generation, !Task.isCancelled else { return }
        let capture = try SimulatorVoiceFixture(sourceURL: sourceURL)
        fixture = capture
        recording = true
        elapsed = 0
        levels = []
        meter = Task {
          while !Task.isCancelled, recording {
            do {
              let level = try capture.append()
              elapsed = capture.elapsed
              sample(level)
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
    // Recording suppresses UIKit feedback unless the audio session opts in.
    try session.setAllowHapticsAndSystemSoundsDuringRecording(true)
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
    levels = []
    meter = Task {
      while !Task.isCancelled, recording {
        r.updateMeters()
        elapsed = r.currentTime
        sample(CGFloat(VoiceLevel.normalized(decibels: Double(r.averagePower(forChannel: 0)))))
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
    level = 0
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

// MARK: - Gesture

/// Press, move, release and system cancellation for the mic, which SwiftUI's DragGesture
/// can't report reliably (it has no cancelled state).
struct VoicePressGesture: UIGestureRecognizerRepresentable {
  var began: (CGPoint) -> Void
  var changed: (CGPoint) -> Void
  var ended: (CGPoint) -> Void
  var cancelled: () -> Void

  func makeUIGestureRecognizer(context: Context) -> VoicePressRecognizer { VoicePressRecognizer() }

  func handleUIGestureRecognizerAction(_ recognizer: VoicePressRecognizer, context: Context) {
    // Window coordinates straight from UIKit. The SwiftUI converter reads the knob's geometry,
    // which this same gesture is moving, and that re-entrant read traps in AttributeGraph.
    let point = recognizer.location(in: nil)
    let event: (() -> Void)?
    switch recognizer.state {
    case .began: event = { began(point) }
    case .changed: event = { changed(point) }
    case .ended: event = { ended(point) }
    case .cancelled, .failed: event = cancelled
    default: event = nil
    }
    // SwiftUI delivers this action in the middle of its own view update (while it updates the
    // knob that carries the gesture). A phase change made there is missed by views already
    // updated in that pass: the knob turned into Send while the bar stayed empty. Apply the
    // events on the next main-queue turn instead, in order.
    if let event { DispatchQueue.main.async(execute: event) }
  }
}

/// Begins on touch-down and ends on lift, however short the touch. A zero-duration
/// UILongPressGestureRecognizer fails silently when the finger lifts before it begins,
/// so a quick tap would never reach the "hold to record" hint.
final class VoicePressRecognizer: UIGestureRecognizer {
  private weak var touch: UITouch?

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesBegan(touches, with: event)
    guard state == .possible, touch == nil, let first = touches.first else { return }
    touch = first
    state = .began
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesMoved(touches, with: event)
    guard let touch, touches.contains(touch), state == .began || state == .changed else { return }
    state = .changed
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesEnded(touches, with: event)
    guard let touch, touches.contains(touch) else { return }
    state = state == .began || state == .changed ? .ended : .failed
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesCancelled(touches, with: event)
    guard let touch, touches.contains(touch) else { return }
    state = .cancelled
  }

  override func reset() {
    super.reset()
    touch = nil
  }

  /// The tracked touch's position in window coordinates.
  override func location(in view: UIView?) -> CGPoint {
    touch?.location(in: view) ?? super.location(in: view)
  }
}

// MARK: - Knob

/// The one control that is the mic at rest, Send while recording and Cancel while transcribing.
/// It carries the press gesture, so it stays the same view through every phase.
struct VoiceKnob: View {
  @ObservedObject var memo: VoiceMemoController
  /// The mic is offered (empty draft).
  let available: Bool
  let enabled: Bool
  @VoiceMotionPreference private var reduceMotion
  /// UIKit-bridged gestures ignore `.disabled`, so the composer's own state is checked here
  /// (ChatView disables it until history is positioned).
  @Environment(\.isEnabled) private var environmentEnabled

  private struct Look {
    var center: CGPoint
    var size: CGSize
    var fill: Color
    var ink: Color
    var symbol: String
    var iconSize: CGFloat
    var hit: CGFloat
  }

  private static let mic = CGPoint(x: -27, y: -22)
  private static let restFill = Color(red: 118 / 255, green: 118 / 255, blue: 128 / 255).opacity(0.24)

  private var look: Look {
    switch memo.phase {
    case .holding, .locked, .review:
      return Look(center: VoiceBar.sendCenter, size: CGSize(width: VoiceBar.button, height: VoiceBar.button),
        fill: NativePalette.text, ink: NativePalette.onPrimary, symbol: "arrow.up", iconSize: 17, hit: 48)
    case .transcribing:
      return Look(center: VoiceBar.sendCenter, size: CGSize(width: 32, height: 32), fill: Self.restFill,
        ink: NativePalette.chatMuted, symbol: "xmark", iconSize: 12, hit: 44)
    default:
      return Look(center: Self.mic, size: CGSize(width: 36, height: 28), fill: Self.restFill,
        ink: NativePalette.chatMuted, symbol: "mic.fill", iconSize: 16, hit: 44)
    }
  }

  private var visible: Bool { memo.phase != .cancelling && (memo.phase != .idle || available) }

  var body: some View {
    // Not rendered while Send owns the slot: an invisible element would still be announced
    // and found by UI tests. No press can be in flight then (the mic needs an empty draft).
    if visible {
      // Discard owns the slot until its animation completes; don't flash a mic
      // behind the falling trash or leave a fading interactive Send behind.
      knob.transition(.identity)
    }
  }

  private var knob: some View {
    let look = look
    let armed = memo.phase == .holding && memo.tracker.cancelArmed
    return ZStack {
      RoundedRectangle(cornerRadius: min(look.size.width, look.size.height) / 2, style: .continuous)
        .fill(look.fill)
        .frame(width: look.size.width, height: look.size.height)
      Image(systemName: look.symbol)
        .font(.system(size: look.iconSize, weight: look.symbol == "mic.fill" ? .regular : .semibold))
        .foregroundStyle(look.ink)
        .contentTransition(reduceMotion ? .opacity : .symbolEffect(.replace))
        .frame(width: 24, height: 24).clipped()
    }
    // Discord greys Send out while a release would cancel.
    .opacity(armed ? 0.35 : 1)
    .scaleEffect(memo.phase == .pressing ? 0.88 : 1)
    .frame(width: look.hit, height: look.hit)
    .contentShape(Rectangle())
    .gesture(VoicePressGesture(
      began: { memo.press(at: $0, enabled: enabled && available && environmentEnabled) },
      changed: { memo.move(to: $0) },
      ended: { memo.release(at: $0) },
      cancelled: { memo.cancelTouch() }))
    .modifier(KnobAccessibility(memo: memo, enabled: enabled && environmentEnabled))
    .frame(width: 64, height: 64)
    .offset(x: look.center.x + 32, y: look.center.y + 32)
    .disabled(memo.phase == .idle && !enabled)
  }
}

/// One modifier chain for every phase. Branching here would rebuild the view that carries
/// the press gesture mid-touch, and UIKit would cancel the hold the moment its UI appears.
private struct KnobAccessibility: ViewModifier {
  @ObservedObject var memo: VoiceMemoController
  let enabled: Bool

  private var role: (label: String, identifier: String, hint: String) {
    switch memo.phase {
    case .locked, .review: ("Send voice note", "voice-send-button", "")
    case .transcribing: ("Cancel transcription", "voice-cancel-transcription", "")
    case .holding: ("Release to send", "voice-knob", "Slide left to cancel, or up to lock.")
    default:
      ("Record voice note", "voice-record-button",
        "Double-tap to record hands-free. Or hold to record and release to send.")
    }
  }

  func body(content: Content) -> some View {
    let role = role
    content.accessibilityElement()
      .accessibilityAddTraits(.isButton)
      .accessibilityLabel(role.label)
      .accessibilityHint(role.hint)
      .accessibilityIdentifier(role.identifier)
      .accessibilityAction { activate() }
  }

  private func activate() {
    switch memo.phase {
    case .idle: if enabled { memo.startLocked() }
    case .locked, .review: memo.send()
    case .transcribing: memo.cancelTranscription()
    default: break
    }
  }
}

// MARK: - Lock

/// Floats above Send while holding: grows and fills as the finger slides up, snaps shut on
/// lock, then leaves.
struct VoiceLockCapsule: View {
  @ObservedObject var memo: VoiceMemoController
  @VoiceMotionPreference private var reduceMotion

  var body: some View {
    let locked = memo.phase == .locked || memo.phase == .review
    let closed = memo.lockFlash || locked
    let progress = closed ? 1 : memo.tracker.lockProgress
    // Settled once locked: the status stays above Send without the drag's lift.
    let lift = locked && !memo.lockFlash ? 0 : progress
    let width: CGFloat = 40
    // Open: lock over a chevron. Locked: the chevron goes and the capsule settles into a circle.
    let height: CGFloat = closed ? width : 68
    VStack(spacing: 6) {
      Image(systemName: closed ? "lock.fill" : "lock.open.fill")
        .font(.system(size: 16, weight: .semibold))
        .contentTransition(reduceMotion ? .opacity : .symbolEffect(.replace))
        .frame(width: 20, height: 20)
        // The open shackle pulls the glyph's body left of its frame; this centres the body.
        .offset(x: closed ? 0 : 1.5)
      if !closed {
        // Driven by the clock rather than a repeating animation, so the bob never shares a
        // transaction with the capsule's own transitions.
        TimelineView(.animation(paused: reduceMotion)) { context in
          let t = context.date.timeIntervalSinceReferenceDate
          Image(systemName: "chevron.up")
            .font(.system(size: 11, weight: .bold))
            .offset(y: reduceMotion ? 0 : 2 * sin(t * 2 * .pi / 1.5))
        }
        .frame(width: 14, height: 12)
        .opacity(1 - progress * 0.8)
        .transition(.opacity)
      }
    }
    .foregroundStyle(NativePalette.text)
    .frame(width: width, height: height)
    .background(alignment: .bottom) {
      Capsule().fill(NativePalette.text.opacity(0.16)).frame(height: height * progress)
    }
    .clipShape(Capsule())
    .nativeChatGlass(radius: width / 2)
    .animation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.78), value: closed)
    .scaleEffect(0.86 + 0.34 * lift, anchor: .bottom)
    .offset(y: -12 * lift)
    // Sliding toward cancel retires the lock.
    .opacity(memo.phase == .holding ? 1 - memo.tracker.cancelProgress : 1)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

/// "Release to Send", or "Release to Cancel" once a release would discard.
struct VoiceReleaseLabel: View {
  let armed: Bool
  var body: some View {
    Text(armed ? "Release to Cancel" : "Release to Send")
      .font(.subheadline.weight(.medium))
      .foregroundStyle(armed ? Color(uiColor: .systemRed) : NativePalette.chatMuted)
      .contentTransition(.opacity)
      // Keep large accessibility text clear of the lock above the trailing end.
      .lineLimit(1).minimumScaleFactor(0.7)
      .frame(maxWidth: .infinity).padding(.horizontal, 56)
      .accessibilityIdentifier("voice-release-label")
  }
}

// MARK: - Bar content

/// What the recording bar shows: [trash] [● 0:04 waveform] [send], or the transcribing row.
struct VoiceBarContent: View {
  @ObservedObject var memo: VoiceMemoController
  @Namespace private var shared
  @VoiceMotionPreference private var reduceMotion

  /// The controls arrive once the goo has mostly formed the bar, and leave before it splits.
  private var fade: AnyTransition {
    reduceMotion ? .opacity : .asymmetric(
      insertion: .opacity.combined(with: .scale(scale: 0.94)).animation(.easeOut(duration: 0.22).delay(0.16)),
      removal: .opacity.combined(with: .scale(scale: 0.94)).animation(.easeIn(duration: 0.12)))
  }

  var body: some View {
    ZStack {
      switch memo.phase {
      case .holding, .locked, .review:
        recording.transition(fade)
      case .transcribing:
        transcribing.transition(fade)
      case .cancelling:
        HStack {
          VoiceTrashDrop(replay: memo.trashes).padding(.leading, VoiceBar.inset + 4)
            .matchedGeometryEffect(id: "lead", in: shared)
          Spacer(minLength: 0)
        }.transition(.opacity)
      case .idle, .pressing:
        EmptyView()
      }
    }
    .frame(height: VoiceBar.height)
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("voice-memo-bar")
  }

  private var recording: some View {
    let slide = memo.phase == .holding ? memo.tracker.cancelFeedbackProgress : 0
    return HStack(spacing: 8) {
      // The attachment control above the surface owns the persistent + → trash morph.
      Color.clear.frame(width: VoiceBar.button)
      VoiceClock(recorder: memo.recorder, live: memo.isRecording)
      VoiceWaveform(recorder: memo.recorder, live: memo.isRecording)
        .frame(height: 26).frame(maxWidth: .infinity)
      Color.clear.frame(width: VoiceBar.button)
    }
    .padding(.horizontal, VoiceBar.inset)
    .frame(height: VoiceBar.height)
    .background {
      // A translucent red wash travels left to right, with a broad feather back into
      // the glass. The dead zone keeps small finger drift completely clear.
      LinearGradient(
        stops: [
          .init(color: Color(uiColor: .systemRed).opacity(0.52), location: 0),
          .init(color: Color(uiColor: .systemRed).opacity(0.24), location: 0.45),
          .init(color: Color(uiColor: .systemRed).opacity(0.025), location: 1),
        ],
        startPoint: .leading, endPoint: .trailing
      )
      .opacity(slide)
      .mask {
        GeometryReader { bar in
          LinearGradient(stops: [
            .init(color: .white, location: 0),
            .init(color: .white.opacity(0.45), location: 0.45),
            .init(color: .clear, location: 1),
          ], startPoint: .leading, endPoint: .trailing)
          .frame(width: bar.size.width * slide * 1.35)
        }
      }
      .clipShape(RoundedRectangle(cornerRadius: VoiceBar.height / 2, style: .continuous))
      .allowsHitTesting(false)
    }
  }

  private var transcribing: some View {
    HStack(spacing: 10) {
      LoadingOrb(size: 22, label: "Transcribing")
        .matchedGeometryEffect(id: "lead", in: shared)
      Text("Transcribing…").font(.body).lineLimit(1).minimumScaleFactor(0.5)
        .foregroundStyle(NativePalette.chatMuted)
        .accessibilityHidden(true)
      Spacer(minLength: 0)
      Color.clear.frame(width: VoiceBar.button)
    }
    .padding(.leading, 14).padding(.trailing, VoiceBar.inset)
  }
}

/// One symbol and one target survive the idle → recording transition. The menu's
/// UIKit button remains underneath at rest; this target only handles recorded takes.
struct VoiceAttachmentMorph: View {
  @ObservedObject var memo: VoiceMemoController
  @VoiceMotionPreference private var reduceMotion

  var body: some View {
    let bar = memo.showsBar
    let recording = memo.phase == .holding || memo.phase == .locked || memo.phase == .review
    let red = memo.phase == .holding ? memo.tracker.cancelFeedbackProgress : 0
    let armed = memo.phase == .holding && memo.tracker.cancelArmed
    Button { memo.discardRecording() } label: {
      ZStack {
        Circle().fill(NativePalette.text.opacity(recording ? 0.08 * (1 - red) : 0))
        Circle().fill(Color(uiColor: .systemRed)).opacity(red)
        Image(systemName: recording ? (armed ? "trash.fill" : "trash") : "plus")
          .font(.system(size: 16, weight: recording ? .medium : .regular))
          .foregroundStyle(red > 0.5 ? Color.white : recording ? NativePalette.chatMuted : NativePalette.text)
          .contentTransition(reduceMotion ? .opacity : .symbolEffect(.replace))
          .frame(width: 22, height: 22).clipped()
      }
      // Inset the backplate from the glass throughout the merge; the 44 pt
      // interaction target stays unchanged.
      .frame(width: recording ? 36 : 40, height: recording ? 36 : 40)
      .scaleEffect(armed ? 1.1 : 1 + 0.06 * red)
      .frame(width: 44, height: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .offset(x: bar ? VoiceBar.inset + VoiceBar.button / 2 - 22 : 0,
      y: bar ? -(VoiceBar.height / 2 - 22) : 0)
    .opacity(!bar || recording ? 1 : 0)
    .allowsHitTesting(recording && memo.phase != .holding)
    .accessibilityHidden(!recording || memo.phase == .holding)
    .animation(reduceMotion ? nil : .interactiveSpring(response: 0.18, dampingFraction: 0.86), value: red)
    .animation(reduceMotion ? nil : .spring(response: 0.26, dampingFraction: 0.55), value: armed)
    .accessibilityLabel("Discard recording")
    .accessibilityIdentifier("voice-discard-button")
  }
}

/// Pulsing red dot and m:ss, the recording's clock.
struct VoiceClock: View {
  @ObservedObject var recorder: VoiceRecorder
  let live: Bool
  @VoiceMotionPreference private var reduceMotion

  var body: some View {
    HStack(spacing: 7) {
      TimelineView(.animation(paused: !live || reduceMotion)) { context in
        let t = context.date.timeIntervalSinceReferenceDate
        Circle().fill(live ? Color(uiColor: .systemRed) : NativePalette.chatMuted)
          .frame(width: 8, height: 8)
          .opacity(live && !reduceMotion ? 0.6 + 0.4 * cos(t * 2 * .pi / 1.3) : 1)
      }
      Text(VoiceMemoText.duration(recorder.elapsed))
        .font(.system(size: 16, weight: .semibold)).monospacedDigit()
        .foregroundStyle(NativePalette.text)
        .fixedSize()
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(live ? "Recording voice note" : "Voice note ready")
    .accessibilityValue("\(Int(recorder.elapsed)) seconds")
    .accessibilityIdentifier("voice-clock")
  }
}

/// Discord's waveform: dots while silent, bars with the voice, new samples sliding in from
/// the right between the recorder's 100 ms readings.
struct VoiceWaveform: View {
  @ObservedObject var recorder: VoiceRecorder
  let live: Bool

  private static let slot: CGFloat = 5.5
  private static let bar: CGFloat = 3

  var body: some View {
    TimelineView(.animation(paused: !live)) { context in
      let levels = recorder.levels
      let travel = live ? min(1, max(0, context.date.timeIntervalSince(recorder.lastSampleAt) / 0.1)) : 1
      Canvas { canvas, size in
        let count = Int(size.width / Self.slot) + 2
        let recent = Array(levels.suffix(count))
        let padding = count - recent.count
        let ink = live ? NativePalette.text : NativePalette.chatMuted
        // The newest sample enters past the right edge and slides into place.
        let newest = size.width - Self.bar / 2 + (1 - travel) * Self.slot
        for index in 0..<count {
          let level = index < padding ? 0 : recent[index - padding]
          let x = newest - CGFloat(count - 1 - index) * Self.slot
          guard x > -Self.slot, x < size.width + Self.slot else { continue }
          if level < 0.07 {
            let d: CGFloat = 2.6
            canvas.fill(Path(ellipseIn: CGRect(x: x - d / 2, y: (size.height - d) / 2, width: d, height: d)),
              with: .color(ink.opacity(0.5)))
          } else {
            let height = max(6, min(size.height, level * size.height))
            let rect = CGRect(x: x - Self.bar / 2, y: (size.height - height) / 2, width: Self.bar, height: height)
            canvas.fill(Path(roundedRect: rect, cornerRadius: Self.bar / 2), with: .color(ink.opacity(0.92)))
          }
        }
      }
    }
    .clipped()
    .accessibilityHidden(true)
  }
}

/// The cancel animation: the red mic hops up and drops into a trash can whose lid closes.
struct VoiceTrashDrop: View {
  let replay: Int
  @VoiceMotionPreference private var reduceMotion
  @State private var play = false

  private struct Frame {
    var micX = 20.0, micY = 0.0, micAngle = 0.0, micScale = 1.0, micOpacity = 1.0
    var canY = 22.0, canOpacity = 0.0, lid = 0.0
  }

  var body: some View {
    if reduceMotion {
      Image(systemName: "trash").font(.system(size: 17)).foregroundStyle(NativePalette.chatMuted)
        .frame(width: 30, height: 30)
    } else {
      Color.clear.frame(width: 30, height: 30)
      .overlay {
        KeyframeAnimator(initialValue: Frame(), trigger: play) { f in
          ZStack {
            Group {
              TrashCanBody().stroke(NativePalette.chatMuted, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
                .frame(width: 14, height: 15).offset(y: 4)
              TrashLid().stroke(NativePalette.chatMuted, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
                .frame(width: 18, height: 5)
                .rotationEffect(.degrees(f.lid), anchor: .bottomLeading)
                .offset(y: -6)
            }
            .offset(y: f.canY).opacity(f.canOpacity)
            Image(systemName: "mic.fill").font(.system(size: 15, weight: .medium))
              .foregroundStyle(Color(uiColor: .systemRed))
              .scaleEffect(f.micScale).rotationEffect(.degrees(f.micAngle))
              .offset(x: f.micX, y: f.micY).opacity(f.micOpacity)
          }
          .frame(width: 30, height: 30)
        } keyframes: { _ in
          // The mic leaves the recording dot, arcs up and over, and drops into the can.
          KeyframeTrack(\.micX) {
            CubicKeyframe(9, duration: 0.3)
            CubicKeyframe(0, duration: 0.24)
          }
          KeyframeTrack(\.micY) {
            CubicKeyframe(-36, duration: 0.3)
            CubicKeyframe(-36, duration: 0.04)
            CubicKeyframe(3, duration: 0.22)
          }
          KeyframeTrack(\.micAngle) {
            CubicKeyframe(-25, duration: 0.3)
            LinearKeyframe(150, duration: 0.26)
          }
          KeyframeTrack(\.micScale) {
            CubicKeyframe(1.15, duration: 0.3)
            CubicKeyframe(0.5, duration: 0.26)
          }
          KeyframeTrack(\.micOpacity) {
            LinearKeyframe(1, duration: 0.5)
            LinearKeyframe(0, duration: 0.06)
          }
          KeyframeTrack(\.canY) {
            SpringKeyframe(0, duration: 0.3, spring: .snappy)
            LinearKeyframe(0, duration: 0.34)
            CubicKeyframe(24, duration: 0.2)
          }
          KeyframeTrack(\.canOpacity) {
            LinearKeyframe(1, duration: 0.16)
            LinearKeyframe(1, duration: 0.5)
            LinearKeyframe(0, duration: 0.18)
          }
          KeyframeTrack(\.lid) {
            CubicKeyframe(-40, duration: 0.22)
            LinearKeyframe(-40, duration: 0.32)
            SpringKeyframe(0, duration: 0.14, spring: .bouncy)
          }
        }
      }
      .onAppear { play.toggle() }
      .onChange(of: replay) { _, _ in play.toggle() }
      .accessibilityHidden(true)
    }
  }
}

private struct TrashCanBody: Shape {
  func path(in rect: CGRect) -> Path {
    var p = Path()
    let inset = rect.width * 0.1
    p.move(to: CGPoint(x: rect.minX, y: rect.minY))
    p.addLine(to: CGPoint(x: rect.minX + inset, y: rect.maxY - 2))
    p.addQuadCurve(to: CGPoint(x: rect.minX + inset + 2, y: rect.maxY),
      control: CGPoint(x: rect.minX + inset, y: rect.maxY))
    p.addLine(to: CGPoint(x: rect.maxX - inset - 2, y: rect.maxY))
    p.addQuadCurve(to: CGPoint(x: rect.maxX - inset, y: rect.maxY - 2),
      control: CGPoint(x: rect.maxX - inset, y: rect.maxY))
    p.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
    for fraction in [0.36, 0.64] {
      let x = rect.minX + rect.width * fraction
      p.move(to: CGPoint(x: x, y: rect.minY + 3.5))
      p.addLine(to: CGPoint(x: x, y: rect.maxY - 3.5))
    }
    return p
  }
}

private struct TrashLid: Shape {
  func path(in rect: CGRect) -> Path {
    var p = Path()
    p.move(to: CGPoint(x: rect.minX, y: rect.maxY))
    p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
    let handle = rect.width * 0.3
    p.move(to: CGPoint(x: rect.midX - handle / 2, y: rect.maxY))
    p.addLine(to: CGPoint(x: rect.midX - handle / 2, y: rect.minY))
    p.addLine(to: CGPoint(x: rect.midX + handle / 2, y: rect.minY))
    p.addLine(to: CGPoint(x: rect.midX + handle / 2, y: rect.maxY))
    return p
  }
}

// MARK: - Gooey surface

/// The attachment circle and message capsule share a single glass effect. The
/// boolean union removes the overlapping interior boundaries as they merge.
/// The same path clips content throughout the morph.
struct VoiceComposerShape: Shape {
  var progress: Double
  var pillHeight: Double
  /// Draft content starts after the attachment slot; use the same path in its coordinates.
  var contentInset: CGFloat = 0
  var animatableData: Double {
    get { progress }
    set { progress = newValue }
  }

  func path(in bounds: CGRect) -> Path {
    let rect = CGRect(x: bounds.minX - contentInset, y: bounds.minY,
      width: bounds.width + contentInset, height: bounds.height)
    let q = min(1, max(0, progress))
    func mix(_ a: CGFloat, _ b: CGFloat) -> CGFloat { a + (b - a) * q }
    let height = mix(CGFloat(pillHeight), VoiceBar.height)
    let left = mix(54, 0)
    let pill = CGRect(x: rect.minX + left, y: rect.maxY - height,
      width: max(0, rect.width - left), height: height)
    // Multiline drafts keep their 22 pt corners; using half their full height
    // cuts into the first/last lines of text before recording starts.
    let corner = mix(min(CGFloat(pillHeight) / 2, 22), VoiceBar.height / 2)
    let capsule = RoundedRectangle(cornerRadius: corner, style: .continuous).path(in: pill)
    let radius = mix(22, 20)
    let center = CGPoint(x: rect.minX + mix(22, VoiceBar.inset + VoiceBar.button / 2),
      y: rect.maxY - mix(22, VoiceBar.height / 2))
    let attachment = Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius,
      width: 2 * radius, height: 2 * radius))
    return Path(capsule.cgPath.union(attachment.cgPath))
  }
}

/// A persistent surface: no idle/recording handoff, no second rim, and no
/// unattached control while the capsule expands over the attachment circle.
struct VoiceBarSurface: View, @preconcurrency Animatable {
  var progress: Double
  let pillHeight: Double
  var animatableData: Double {
    get { progress }
    set { progress = newValue }
  }
  @Environment(\.colorScheme) private var scheme
  private var shape: VoiceComposerShape {
    VoiceComposerShape(progress: progress, pillHeight: pillHeight)
  }

  var body: some View {
    surface
      .allowsHitTesting(false)
      .accessibilityHidden(true)
  }

  @ViewBuilder private var surface: some View {
    if #available(iOS 26, *) {
      Color.clear.glassEffect(material, in: shape)
        // Only the glass leaf suppresses implicit interpolation. The enclosing
        // Animatable view must keep sampling the actual shared spring.
        .transaction { $0.animation = nil }
    } else {
      shape.fill(.regularMaterial)
        .shadow(color: .black.opacity(scheme == .dark ? 0 : 0.08), radius: 10, y: 3)
    }
  }

  @available(iOS 26, *)
  private var material: Glass {
    scheme == .dark
      ? Glass.clear.tint(Color(white: 55 / 255).opacity(0.5))
      : Glass.regular.tint(.black.opacity(0.025))
  }
}

// MARK: - Glow

/// The voice glow, full width and anchored to the bottom of the screen behind the composer.
/// It rises with the voice and sweeps while transcribing.
struct VoiceGlowBackdrop: View {
  @ObservedObject var memo: VoiceMemoController
  /// Beside a sidebar the glow starts at the chat column, mid-screen, with a square corner.
  var squareLeading = false
  @VoiceMotionPreference private var reduceMotion
  /// The level is already normalised like the waveform's bars, so no extra gain: the glow
  /// rises and falls with the same syllables instead of pinning at full.
  private static let options: VoiceGlowOptions = {
    var options = VoiceGlowOptions()
    options.sensitivity = 1.15
    options.threshold = 0.04
    options.attack = 0.08
    options.release = 0.3
    options.idle = 0.12
    return options
  }()

  /// The display's bottom corner radii, which the glow's corners follow. They
  /// differ on iPhone Duo's outer display, squarer on the hinge side.
  @State private var corners = DisplayCorners(left: 55, right: 55)

  var body: some View {
    let left = squareLeading ? 0 : corners.left
    // Use the phone-sized host and the mobile preset’s natural reach and falloff.
    // The glow traces the tighter corner and the display's own shape clips the other.
    Color.clear
      .voiceGlow(type: .mobile, levelProvider: { memo.glowLevel() }, motion: { memo.glowMotion() },
        active: memo.glowActive && !reduceMotion, cornerRadius: min(left, corners.right),
        options: Self.options)
      .clipShape(UnevenRoundedRectangle(
        bottomLeadingRadius: left, bottomTrailingRadius: corners.right, style: .continuous))
      .environment(\.layoutDirection, .leftToRight)
      .background(DisplayCornerProbe { corners = $0 })
      // Beside a sidebar the chat column clips what's in it, so while the glow
      // shows it reaches past the column to the screen's edges.
      .background(UnclippedAncestors(active: memo.glowActive))
      .allowsHitTesting(false)
      .accessibilityHidden(true)
  }
}

/// Lifts clipping from the views around this one while `active`, restoring it a
/// moment after, once the glow has faded. Transitions keep their clipping.
private struct UnclippedAncestors: UIViewRepresentable {
  var active: Bool
  func makeUIView(context: Context) -> ProbeView { ProbeView() }
  func updateUIView(_ view: ProbeView, context: Context) { view.active = active }

  final class ProbeView: UIView {
    private var lifted: [UIView] = []
    private var restore: DispatchWorkItem?
    var active = false {
      didSet {
        guard active != oldValue else { return }
        restore?.cancel()
        if active {
          lift()
        } else {
          let work = DispatchWorkItem { [weak self] in self?.reclip() }
          restore = work
          DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: work)
        }
      }
    }
    override init(frame: CGRect) {
      super.init(frame: frame)
      isUserInteractionEnabled = false
    }
    required init?(coder: NSCoder) { fatalError() }
    override func willMove(toWindow newWindow: UIWindow?) {
      super.willMove(toWindow: newWindow)
      if newWindow == nil { reclip() }
    }
    private func lift() {
      var view = superview
      while let current = view, !(current is UIWindow) {
        if current.clipsToBounds, !(current is UIScrollView) {
          current.clipsToBounds = false
          lifted.append(current)
        }
        view = current.superview
      }
    }
    private func reclip() {
      lifted.forEach { $0.clipsToBounds = true }
      lifted = []
    }
  }
}

extension EnvironmentValues {
  /// Where the open chat's column starts in the window, beside a sidebar; 0 otherwise.
  @Entry var chatColumnLeading: CGFloat = 0
}

struct DisplayCorners: Equatable {
  var left: CGFloat
  var right: CGFloat
}

/// Reports the radii of the bottom screen corners a window-sized view sits in: 55 pt
/// on most iPhones, and each of iPhone Duo's displays' own, which can differ by side.
private struct DisplayCornerProbe: UIViewRepresentable {
  var update: (DisplayCorners) -> Void
  func makeUIView(context: Context) -> ProbeView { ProbeView() }
  func updateUIView(_ view: ProbeView, context: Context) { view.update = update }

  final class ProbeView: UIView {
    var update: ((DisplayCorners) -> Void)?
    private var last: DisplayCorners?
    override init(frame: CGRect) {
      super.init(frame: frame)
      isUserInteractionEnabled = false
      if #available(iOS 26, *) { cornerConfiguration = .corners(radius: .containerConcentric()) }
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layoutSubviews() {
      super.layoutSubviews()
      guard #available(iOS 26, *), window != nil else { return }
      let corners = DisplayCorners(
        left: effectiveRadius(corner: .bottomLeft), right: effectiveRadius(corner: .bottomRight))
      guard corners.left > 0 || corners.right > 0, corners != last else { return }
      last = corners
      let update = update
      DispatchQueue.main.async { update?(corners) }
    }
  }
}

/// A transient note above the composer (the microphone failed to start).
struct VoiceHintBubble: View {
  let text: String
  var body: some View {
    Text(text).font(.footnote.weight(.medium)).foregroundStyle(NativePalette.text)
      .padding(.horizontal, 14).padding(.vertical, 9)
      .nativeChatGlass(radius: 17, regularInLightMode: true)
      .fixedSize()
      .accessibilityIdentifier("voice-hint")
  }
}
