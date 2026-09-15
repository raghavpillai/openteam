import AVFoundation
import ExpoModulesCore
import QuickLook
import UIKit

// Expo's string-based rejection overload loses its reason in debug builds.
// Supply a typed exception so production and development show the same message.
private final class VoiceRecordingException: GenericException<(code: String, message: String)>, @unchecked Sendable {
  override var code: String { param.code }
  override var reason: String { param.message }
  override var debugDescription: String { reason }
}

public final class OpenTeamNativeModule: Module, QLPreviewControllerDataSource {
  private var recorder: AVAudioRecorder?
  private var recordingURL: URL?
  private var levelTimer: Timer?
  private var interruptionObserver: NSObjectProtocol?
  private var generation = 0
  private var previewURL: URL?

  public func definition() -> ModuleDefinition {
    Name("OpenTeamNative")
    Events("onSpeechLevel", "onSpeechError")

    AsyncFunction("reconcileNotificationReads") { (states: [[String: String]], promise: Promise) in
      OpenTeamNotificationReads.reconcile(states) { promise.resolve(nil) }
    }

    AsyncFunction("startVoiceRecording") { (promise: Promise) in
      DispatchQueue.main.async { [weak self] in
        guard let self else { promise.reject(VoiceRecordingException(("unavailable", "Recorder is unavailable."))); return }
        self.cancelRecording()
        let requestGeneration = self.generation
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
          DispatchQueue.main.async {
            guard let self, self.generation == requestGeneration else {
              promise.reject(VoiceRecordingException(("cancelled", "Recording cancelled."))); return
            }
            guard granted else {
              promise.reject(VoiceRecordingException(("permission", "Allow microphone access in Settings to record a voice note."))); return
            }
            do {
              let session = AVAudioSession.sharedInstance()
              try session.setCategory(.record, mode: .measurement)
              try session.setActive(true)
              let directory = FileManager.default.temporaryDirectory.appendingPathComponent("openteam-voice-notes", isDirectory: true)
              try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
              // These are only this module's temporary voice-note files.
              for old in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
                let date = (try? old.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                if date < Date().addingTimeInterval(-86400) { try? FileManager.default.removeItem(at: old) }
              }
              let url = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension("wav")
              self.recordingURL = url
              let recorder = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
              ])
              self.recorder = recorder
              recorder.isMeteringEnabled = true
              guard recorder.record() else { throw NSError(domain: "OpenTeam", code: 1) }
              self.levelTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
                guard let self, let recorder = self.recorder else { return }
                recorder.updateMeters()
                let level = max(0, min(1, (Double(recorder.averagePower(forChannel: 0)) + 55) / 55))
                self.sendEvent("onSpeechLevel", ["level": level])
              }
              self.interruptionObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] _ in
                guard let self, self.recorder != nil else { return }
                self.cancelRecording()
                self.sendEvent("onSpeechError", ["code": "interrupted", "message": "Recording was interrupted. Try again."])
              }
              promise.resolve(nil)
            } catch {
              self.cancelRecording()
              promise.reject(VoiceRecordingException(("unavailable", "OpenTeam could not start the microphone.")))
            }
          }
        }
      }
    }

    AsyncFunction("stopVoiceRecording") { (promise: Promise) in
      DispatchQueue.main.async { [weak self] in
        guard let self, let recorder = self.recorder, let url = self.recordingURL else {
          promise.reject(VoiceRecordingException(("unavailable", "No recording is active."))); return
        }
        let durationMs = recorder.currentTime * 1000
        recorder.stop()
        self.recorder = nil
        self.recordingURL = nil
        self.releaseAudioSession()
        promise.resolve(["uri": url.absoluteString, "mimeType": "audio/wav", "durationMs": durationMs])
      }
    }

    Function("cancelVoiceRecording") {
      DispatchQueue.main.async { [weak self] in self?.cancelRecording() }
    }

    Function("isCameraAvailable") {
      UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    AsyncFunction("openPreview") { (uri: String, promise: Promise) in
      DispatchQueue.main.async { [weak self] in
        guard let self else {
          promise.resolve(false)
          return
        }
        let url = URL(string: uri) ?? URL(fileURLWithPath: uri)
        guard url.isFileURL, FileManager.default.fileExists(atPath: url.path) else {
          promise.resolve(false)
          return
        }
        guard let currentViewController = self.appContext?.utilities?.currentViewController() else {
          promise.resolve(false)
          return
        }
        self.previewURL = url
        let preview = QLPreviewController()
        preview.dataSource = self
        currentViewController.present(preview, animated: true) {
          promise.resolve(true)
        }
      }
    }

    OnDestroy {
      DispatchQueue.main.async { [weak self] in self?.cancelRecording() }
    }
  }

  public func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    previewURL == nil ? 0 : 1
  }

  public func previewController(
    _ controller: QLPreviewController,
    previewItemAt index: Int
  ) -> QLPreviewItem {
    (previewURL ?? URL(fileURLWithPath: "/")) as NSURL
  }

  private func releaseAudioSession() {
    levelTimer?.invalidate()
    levelTimer = nil
    if let observer = interruptionObserver { NotificationCenter.default.removeObserver(observer) }
    interruptionObserver = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func cancelRecording() {
    generation += 1
    recorder?.stop()
    recorder = nil
    if let url = recordingURL { try? FileManager.default.removeItem(at: url) }
    recordingURL = nil
    releaseAudioSession()
  }
}
