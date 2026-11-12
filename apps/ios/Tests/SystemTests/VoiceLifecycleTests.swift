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
}
#endif
