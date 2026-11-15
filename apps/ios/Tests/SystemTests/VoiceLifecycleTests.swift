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

  /// Holds a transcription open until the test answers it.
  @MainActor private final class TranscriptGate {
    private var continuation: CheckedContinuation<String?, Error>?
    var waiting: Bool { continuation != nil }
    func wait() async throws -> String? { try await withCheckedThrowingContinuation { continuation = $0 } }
    func finish(_ result: Result<String?, Error>) { continuation?.resume(with: result); continuation = nil }
  }

  /// Sends a take and leaves its chat while the transcript is still out.
  private func leaveWhileTranscribing(_ memo: VoiceMemoController, key: String) async throws -> TranscriptGate {
    let gate = TranscriptGate()
    memo.transcribe = { _ in try await gate.wait() }
    try await start(memo)
    memo.send()
    try await waitUntil { gate.waiting }
    VoiceMemoSessions.leave(memo, key: key)
    return gate
  }

  func testLeavingTheChatDiscardsARecordingButStillSendsATranscribingNote() async throws {
    let recording = self.memo(), memo = self.memo(), key = "leave-" + UUID().uuidString
    defer { VoiceMemoSessions.reset(); recording.tearDown(); memo.tearDown() }
    try await start(recording)
    VoiceMemoSessions.leave(recording, key: key)
    XCTAssertEqual(recording.phase, .idle)
    XCTAssertFalse(recording.recorder.recording)
    XCTAssertNil(recording.recorder.pendingURL)
    XCTAssertFalse(VoiceMemoSessions.controller(for: key) === recording)
    var delivered: [String] = []
    memo.deliver = { delivered.append($0) }
    let gate = try await leaveWhileTranscribing(memo, key: key)
    XCTAssertEqual(memo.phase, .transcribing, "Leaving the chat must not cancel the transcription")
    XCTAssertTrue(VoiceMemoSessions.controller(for: key) === memo, "Reopening the chat shows the note's progress")
    VoiceMemoSessions.leave(memo, key: key)
    gate.finish(.success("Sent after leaving"))
    try await waitUntil { memo.phase == .idle }
    XCTAssertEqual(delivered, ["Sent after leaving"])
    XCTAssertFalse(VoiceMemoSessions.controller(for: key) === memo, "A sent note is not kept")
  }

  func testFailedTranscriptionAfterLeavingKeepsTheTakeForItsChat() async throws {
    let memo = memo(), key = "leave-" + UUID().uuidString
    defer { VoiceMemoSessions.reset(); memo.tearDown() }
    var reports = 0, deliveries = 0
    memo.deliver = { _ in deliveries += 1 }
    memo.report = { _ in reports += 1 }
    let gate = try await leaveWhileTranscribing(memo, key: key)
    gate.finish(.failure(APIError("Transcription is unavailable.")))
    try await waitUntil { memo.phase == .review }
    XCTAssertEqual(reports, 1)
    XCTAssertEqual(deliveries, 0)
    XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(memo.recorder.pendingURL).path))
    XCTAssertTrue(VoiceMemoSessions.controller(for: key) === memo, "The kept take waits in its chat")
  }

  func testSignOutDropsNotesStillTranscribingElsewhere() async throws {
    let memo = memo(), key = "leave-" + UUID().uuidString
    defer { VoiceMemoSessions.reset(); memo.tearDown() }
    var deliveries = 0
    memo.deliver = { _ in deliveries += 1 }
    let gate = try await leaveWhileTranscribing(memo, key: key)
    VoiceMemoSessions.reset()
    XCTAssertEqual(memo.phase, .idle)
    gate.finish(.success("From the previous account"))
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(deliveries, 0)
    XCTAssertFalse(VoiceMemoSessions.controller(for: key) === memo)
  }
}
#endif
