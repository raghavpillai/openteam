import Foundation
import Observation

/// A foreground handoff from Shortcuts to the existing composer. Nothing here
/// is persisted: a later app launch must never unexpectedly open the microphone.
@MainActor @Observable
final class BotVoiceLaunch {
  struct Request {
    let id = UUID()
    let scope: String
    let channelID: String
    let createdAt: Date
  }
  private(set) var presentation = UUID()
  private(set) var pending: Request?
  @ObservationIgnored private weak var memo: VoiceMemoController?
  private var channelID: String?
  private var composerKey: String?
  private var registeredPresentation: UUID?

  func register(_ memo: VoiceMemoController, channelID: String, key: String) {
    self.memo = memo
    self.channelID = channelID
    composerKey = key
    registeredPresentation = presentation
  }

  func unregister(_ memo: VoiceMemoController) {
    guard self.memo === memo else { return }
    self.memo = nil
    channelID = nil
    composerKey = nil
    registeredPresentation = nil
  }

  /// Repeating a shortcut in the recording's own chat is a no-op. Switching
  /// chats (including leaving a thread) must not discard a recording or retry.
  func canOpen(_ channel: String) throws -> Bool {
    guard let memo, memo.phase != .idle else { return true }
    guard channelID == channel, composerKey == channel else {
      throw APIError("Send or discard your current voice note before opening another Bot.")
    }
    return false
  }

  func open(scope: String, channelID: String, record: Bool, now: Date = .now) {
    // Recreate the selected chat so a shortcut also leaves its details/thread
    // screens. The busy-recording check runs before changing this identity.
    presentation = UUID()
    pending = record ? Request(scope: scope, channelID: channelID, createdAt: now) : nil
  }

  func takeRecording(for memo: VoiceMemoController, scope: String?, channelID: String,
    key: String, visible: Bool, now: Date = .now) -> Bool {
    guard let pending else { return false }
    guard now.timeIntervalSince(pending.createdAt) < 30, pending.scope == scope else {
      self.pending = nil
      return false
    }
    guard visible, pending.channelID == channelID, key == channelID,
      self.memo === memo, registeredPresentation == presentation, memo.phase == .idle else { return false }
    self.pending = nil
    return true
  }

  func cancelPending(unless channel: String?) {
    if pending?.channelID != channel { pending = nil }
  }

  func reset() {
    pending = nil
    memo?.tearDown()
    memo = nil
    channelID = nil
    composerKey = nil
    registeredPresentation = nil
  }
}
