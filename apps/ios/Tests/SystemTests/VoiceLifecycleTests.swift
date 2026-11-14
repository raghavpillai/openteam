import AVFoundation
import XCTest
@testable import OpenTeamNative

#if targetEnvironment(simulator)
/// Exercise the production notification/recording state machine with real AAC
/// files from the simulator fixture. No microphone hardware or server is used.
@MainActor
final class VoiceLifecycleTests: XCTestCase {
  private func memo(limit: TimeInterval = 300, center: NotificationCenter = NotificationCenter()) -> VoiceMemoController {
    let recorder = VoiceRecorder(recordingLimit: limit)
    recorder.usesSyntheticAudioForTesting = true
    return VoiceMemoController(recorder: recorder, notifications: center)
  }

  private func waitUntil(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
    for _ in 0..<100 {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("Recording state did not settle", file: file, line: line)
  }

  private func start(_ memo: VoiceMemoController) async throws {
    memo.startLocked()
    try await waitUntil { memo.recorder.recording }
    try await waitUntil { memo.recorder.elapsed >= 0.1 }
  }

  private func notify(_ center: NotificationCenter, _ name: Notification.Name, key: String? = nil, value: UInt = 0) {
    center.post(name: name, object: nil, userInfo: key.map { [$0: value] })
  }

  func testInterruptionKeepsAudioForReviewAndNeverAutoResumesOrSends() async throws {
    let center = NotificationCenter(), memo = memo(center: center)
    defer { memo.tearDown() }
    var deliveries = 0
    memo.deliver = { _ in deliveries += 1 }
    try await start(memo)
    notify(center, AVAudioSession.interruptionNotification, key: AVAudioSessionInterruptionTypeKey,
      value: AVAudioSession.InterruptionType.began.rawValue)
    try await waitUntil { memo.phase == .review }
    let url = try XCTUnwrap(memo.recorder.pendingURL)
    XCTAssertFalse(memo.recorder.recording)
    XCTAssertGreaterThan(try AVAudioFile(forReading: url).length, 0)
    notify(center, AVAudioSession.interruptionNotification, key: AVAudioSessionInterruptionTypeKey,
      value: AVAudioSession.InterruptionType.ended.rawValue)
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(memo.phase, .review)
    XCTAssertFalse(memo.recorder.recording)
    XCTAssertEqual(deliveries, 0)
    memo.transcribe = { _ in "Retained note" }
    memo.send(); memo.send()
    try await waitUntil { memo.phase == .idle }
    XCTAssertEqual(deliveries, 1)
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }

  func testInputDisconnectAndConnectKeepRecordingForReview() async throws {
    for reason in [AVAudioSession.RouteChangeReason.oldDeviceUnavailable, .newDeviceAvailable,
      .noSuitableRouteForCategory] {
      let center = NotificationCenter(), memo = memo(center: center)
      defer { memo.tearDown() }
      try await start(memo)
      notify(center, AVAudioSession.routeChangeNotification, key: AVAudioSessionRouteChangeReasonKey,
        value: reason.rawValue)
      try await waitUntil { memo.phase == .review }
      XCTAssertFalse(memo.recorder.recording)
      XCTAssertNotNil(memo.recorder.pendingURL)
    }
  }

  func testOwnAudioCategoryChangesDoNotInterruptRecording() async throws {
    let center = NotificationCenter(), memo = memo(center: center)
    defer { memo.tearDown() }
    try await start(memo)
    notify(center, AVAudioSession.routeChangeNotification, key: AVAudioSessionRouteChangeReasonKey,
      value: AVAudioSession.RouteChangeReason.categoryChange.rawValue)
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertTrue(memo.recorder.recording)
    XCTAssertEqual(memo.phase, .locked)
  }

  func testAudioServicesLossAndResetKeepNoteWithoutRestarting() async throws {
    for name in [AVAudioSession.mediaServicesWereLostNotification, AVAudioSession.mediaServicesWereResetNotification] {
      let center = NotificationCenter(), memo = memo(center: center)
      defer { memo.tearDown() }
      try await start(memo)
      notify(center, name)
      try await waitUntil { memo.phase == .review }
      XCTAssertFalse(memo.recorder.recording)
      XCTAssertNotNil(memo.recorder.pendingURL)
    }
  }

  func testRecordingLimitStopsCaptureAndShowsReviewInsteadOfRecording() async throws {
    let memo = memo(limit: 0.25)
    defer { memo.tearDown() }
    try await start(memo)
    try await waitUntil { memo.phase == .review }
    XCTAssertFalse(memo.recorder.recording)
    XCTAssertFalse(memo.isRecording)
    XCTAssertNotNil(memo.recorder.pendingURL)
  }

  func testBackgroundPreservesAudioAndDiscardRemovesIt() async throws {
    let memo = memo()
    defer { memo.tearDown() }
    try await start(memo)
    memo.suspend()
    XCTAssertEqual(memo.phase, .review)
    let url = try XCTUnwrap(memo.recorder.pendingURL)
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    memo.discardRecording()
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    XCTAssertNil(memo.recorder.pendingURL)
  }

  func testHandsFreeStopPreservesAudioForExplicitSend() async throws {
    let memo = memo()
    defer { memo.tearDown() }
    var deliveries = 0
    memo.deliver = { _ in deliveries += 1 }
    try await start(memo)
    memo.stopForReview()
    XCTAssertEqual(memo.phase, .review)
    XCTAssertFalse(memo.recorder.recording)
    let url = try XCTUnwrap(memo.recorder.pendingURL)
    XCTAssertGreaterThan(try AVAudioFile(forReading: url).length, 0)
    XCTAssertEqual(deliveries, 0)
    memo.transcribe = { _ in "Reviewed voice note" }
    memo.send()
    try await waitUntil { memo.phase == .idle }
    XCTAssertEqual(deliveries, 1)
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }

  func testPermissionDeniedReturnsToIdleAndCanRetry() async throws {
    let recorder = VoiceRecorder(permission: { false })
    let memo = VoiceMemoController(recorder: recorder)
    defer { memo.tearDown() }
    var reports = 0
    memo.report = { _ in reports += 1 }
    memo.startLocked()
    try await waitUntil { memo.phase == .idle }
    XCTAssertEqual(reports, 1)
    XCTAssertFalse(recorder.recording)
    recorder.usesSyntheticAudioForTesting = true
    try await start(memo)
    XCTAssertEqual(memo.phase, .locked)
  }

  @MainActor private final class PermissionGate {
    var continuation: CheckedContinuation<Bool, Never>?
    func request() async -> Bool { await withCheckedContinuation { continuation = $0 } }
    func resolve(_ allowed: Bool) { continuation?.resume(returning: allowed); continuation = nil }
  }

  func testBackgroundWhilePermissionPendingCannotOpenMicLater() async throws {
    let gate = PermissionGate()
    let recorder = VoiceRecorder(permission: { await gate.request() })
    let memo = VoiceMemoController(recorder: recorder)
    defer { memo.tearDown(); gate.resolve(false) }
    var reports = 0
    memo.report = { _ in reports += 1 }
    memo.startLocked()
    try await waitUntil { gate.continuation != nil }
    memo.suspend()
    gate.resolve(true)
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(memo.phase, .idle)
    XCTAssertFalse(recorder.recording)
    XCTAssertNil(recorder.pendingURL)
    XCTAssertEqual(reports, 0)
  }

  func testOldPermissionCompletionCannotCancelANewerRecording() async throws {
    let gate = PermissionGate()
    let recorder = VoiceRecorder(permission: { await gate.request() })
    let memo = VoiceMemoController(recorder: recorder)
    defer { memo.tearDown(); gate.resolve(false) }
    memo.startLocked()
    try await waitUntil { gate.continuation != nil }
    memo.suspend()
    recorder.usesSyntheticAudioForTesting = true
    try await start(memo)
    gate.resolve(true)
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertTrue(recorder.recording, "An old permission continuation must not cancel the new capture")
    XCTAssertEqual(memo.phase, .locked)
  }

  /// Holds a transcription open until the test answers it.
  @MainActor private final class TranscriptGate {
    private var continuation: CheckedContinuation<String?, Error>?
    var waiting: Bool { continuation != nil }
    func wait() async throws -> String? { try await withCheckedThrowingContinuation { continuation = $0 } }
    func finish(_ result: Result<String?, Error>) { continuation?.resume(with: result); continuation = nil }
  }

  func testLeavingTheChatWhileTranscribingStillSendsTheNote() async throws {
    let memo = memo(), gate = TranscriptGate(), key = "leave-" + UUID().uuidString
    defer { VoiceMemoSessions.reset(); memo.tearDown() }
    var delivered: [String] = []
    memo.transcribe = { _ in try await gate.wait() }
    memo.deliver = { delivered.append($0) }
    try await start(memo)
    memo.send()
    try await waitUntil { gate.waiting }
    VoiceMemoSessions.leave(memo, key: key)
    XCTAssertEqual(memo.phase, .transcribing, "Leaving the chat must not cancel the transcription")
    XCTAssertTrue(VoiceMemoSessions.controller(for: key) === memo, "Reopening the chat shows the note's progress")
    VoiceMemoSessions.leave(memo, key: key)
    gate.finish(.success("Sent after leaving"))
    try await waitUntil { memo.phase == .idle }
    XCTAssertEqual(delivered, ["Sent after leaving"])
    XCTAssertFalse(VoiceMemoSessions.controller(for: key) === memo, "A sent note is not kept")
  }

  func testFailedTranscriptionAfterLeavingKeepsTheTakeForItsChat() async throws {
    let memo = memo(), gate = TranscriptGate(), key = "leave-" + UUID().uuidString
    defer { VoiceMemoSessions.reset(); memo.tearDown() }
    var reports = 0, deliveries = 0
    memo.transcribe = { _ in try await gate.wait() }
    memo.deliver = { _ in deliveries += 1 }
    memo.report = { _ in reports += 1 }
    try await start(memo)
    memo.send()
    try await waitUntil { gate.waiting }
    VoiceMemoSessions.leave(memo, key: key)
    gate.finish(.failure(APIError("Transcription is unavailable.")))
    try await waitUntil { memo.phase == .review }
    XCTAssertEqual(reports, 1)
    XCTAssertEqual(deliveries, 0)
    let url = try XCTUnwrap(memo.recorder.pendingURL)
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    XCTAssertTrue(VoiceMemoSessions.controller(for: key) === memo, "The kept take waits in its chat")
  }

  func testLeavingWhileRecordingStillDiscardsTheTake() async throws {
    let memo = memo(), key = "leave-" + UUID().uuidString
    defer { VoiceMemoSessions.reset(); memo.tearDown() }
    try await start(memo)
    VoiceMemoSessions.leave(memo, key: key)
    XCTAssertEqual(memo.phase, .idle)
    XCTAssertFalse(memo.recorder.recording)
    XCTAssertNil(memo.recorder.pendingURL)
    XCTAssertFalse(VoiceMemoSessions.controller(for: key) === memo)
  }

  func testSignOutDropsNotesStillTranscribingElsewhere() async throws {
    let memo = memo(), gate = TranscriptGate(), key = "leave-" + UUID().uuidString
    defer { VoiceMemoSessions.reset(); memo.tearDown() }
    var deliveries = 0
    memo.transcribe = { _ in try await gate.wait() }
    memo.deliver = { _ in deliveries += 1 }
    try await start(memo)
    memo.send()
    try await waitUntil { gate.waiting }
    VoiceMemoSessions.leave(memo, key: key)
    VoiceMemoSessions.reset()
    XCTAssertEqual(memo.phase, .idle)
    gate.finish(.success("From the previous account"))
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(deliveries, 0)
    XCTAssertFalse(VoiceMemoSessions.controller(for: key) === memo)
  }

  func testTeardownIgnoresLatePermissionDenial() async throws {
    let gate = PermissionGate()
    let recorder = VoiceRecorder(permission: { await gate.request() })
    let memo = VoiceMemoController(recorder: recorder)
    defer { gate.resolve(false) }
    var reports = 0
    memo.report = { _ in reports += 1 }
    memo.startLocked()
    try await waitUntil { gate.continuation != nil }
    memo.tearDown()
    gate.resolve(false)
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(memo.phase, .idle)
    XCTAssertEqual(reports, 0)
  }
}
#endif
