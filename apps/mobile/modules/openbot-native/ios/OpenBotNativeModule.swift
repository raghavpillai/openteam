import AVFoundation
import ExpoModulesCore
import QuickLook
import Speech
import UIKit

public final class OpenBotNativeModule: Module, QLPreviewControllerDataSource {
  private let audioEngine = AVAudioEngine()
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var speechRecognizer: SFSpeechRecognizer?
  private var lastTranscript = ""
  private var lastLevelAt: TimeInterval = 0
  private var previewURL: URL?
  private var requestGeneration = 0
  private var stopping = false
  private var tapInstalled = false

  public func definition() -> ModuleDefinition {
    Name("OpenBotNative")
    Events("onSpeechState", "onSpeechResult", "onSpeechLevel", "onSpeechError")

    Function("startSpeech") { (locale: String?) in
      DispatchQueue.main.async { [weak self] in
        self?.requestSpeech(locale: locale)
      }
    }

    Function("stopSpeech") {
      DispatchQueue.main.async { [weak self] in
        self?.stopAndTranscribe()
      }
    }

    Function("cancelSpeech") {
      DispatchQueue.main.async { [weak self] in
        self?.cancelRecognition(emitIdle: true)
      }
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
      DispatchQueue.main.async { [weak self] in
        self?.cancelRecognition(emitIdle: false)
      }
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

  private func requestSpeech(locale: String?) {
    cancelRecognition(emitIdle: false)
    requestGeneration += 1
    let generation = requestGeneration
    sendEvent("onSpeechState", ["state": "requesting"])

    SFSpeechRecognizer.requestAuthorization { [weak self] speechStatus in
      AVAudioSession.sharedInstance().requestRecordPermission { granted in
        DispatchQueue.main.async {
          guard let self, generation == self.requestGeneration else { return }
          guard speechStatus == .authorized, granted else {
            self.fail(
              code: "permission",
              message: "Allow microphone and speech recognition access in Settings to dictate."
            )
            return
          }
          self.beginRecognition(locale: locale)
        }
      }
    }
  }

  private func beginRecognition(locale: String?) {
    let selectedLocale = locale.flatMap(Locale.init(identifier:)) ?? Locale.current
    guard let recognizer = SFSpeechRecognizer(locale: selectedLocale), recognizer.isAvailable else {
      fail(code: "unavailable", message: "Speech recognition is not available right now.")
      return
    }

    do {
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(.record, mode: .measurement, options: [.duckOthers])
      try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

      let request = SFSpeechAudioBufferRecognitionRequest()
      request.shouldReportPartialResults = true
      speechRecognizer = recognizer
      recognitionRequest = request
      lastTranscript = ""
      stopping = false

      let inputNode = audioEngine.inputNode
      let format = inputNode.outputFormat(forBus: 0)
      guard format.sampleRate.isFinite, format.sampleRate > 0, format.channelCount > 0 else {
        fail(code: "unavailable", message: "No microphone input is available on this device.")
        return
      }
      inputNode.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak self] buffer, _ in
        guard let self else { return }
        request.append(buffer)
        self.emitLevel(buffer)
      }
      tapInstalled = true
      audioEngine.prepare()
      try audioEngine.start()

      recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
        DispatchQueue.main.async {
          self?.handleRecognition(result: result, error: error)
        }
      }
      sendEvent("onSpeechState", ["state": "recording"])
    } catch {
      fail(code: "unavailable", message: "OpenBot could not start the microphone.")
    }
  }

  private func emitLevel(_ buffer: AVAudioPCMBuffer) {
    let now = Date.timeIntervalSinceReferenceDate
    guard now - lastLevelAt >= 0.08 else { return }
    lastLevelAt = now
    guard let samples = buffer.floatChannelData?[0] else { return }
    let count = Int(buffer.frameLength)
    guard count > 0 else { return }
    var sum: Float = 0
    for index in 0..<count {
      let value = samples[index]
      sum += value * value
    }
    let rms = sqrt(sum / Float(count))
    let decibels = 20 * log10(max(rms, 0.000_01))
    let level = max(0, min(1, (Double(decibels) + 55) / 55))
    DispatchQueue.main.async { [weak self] in
      self?.sendEvent("onSpeechLevel", ["level": level])
    }
  }

  private func handleRecognition(result: SFSpeechRecognitionResult?, error: Error?) {
    if let result {
      lastTranscript = result.bestTranscription.formattedString
      sendEvent("onSpeechResult", [
        "transcript": lastTranscript,
        "final": result.isFinal,
      ])
      if result.isFinal {
        finishRecognition()
        return
      }
    }
    guard error != nil else { return }
    if stopping, !lastTranscript.isEmpty {
      sendEvent("onSpeechResult", ["transcript": lastTranscript, "final": true])
      finishRecognition()
    } else if stopping {
      fail(code: "interrupted", message: "No speech was detected. Try again.")
    } else {
      fail(code: "interrupted", message: "Voice input was interrupted. Try again.")
    }
  }

  private func stopAndTranscribe() {
    guard recognitionRequest != nil else { return }
    stopping = true
    stopAudioInput()
    recognitionRequest?.endAudio()
    sendEvent("onSpeechState", ["state": "processing"])

    let generation = requestGeneration
    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
      guard let self, generation == self.requestGeneration, self.stopping else { return }
      if !self.lastTranscript.isEmpty {
        self.sendEvent("onSpeechResult", ["transcript": self.lastTranscript, "final": true])
        self.finishRecognition()
      } else {
        self.fail(code: "interrupted", message: "No speech was detected. Try again.")
      }
    }
  }

  private func stopAudioInput() {
    if audioEngine.isRunning {
      audioEngine.stop()
    }
    if tapInstalled {
      audioEngine.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }
  }

  private func finishRecognition() {
    cancelRecognition(emitIdle: false)
    sendEvent("onSpeechState", ["state": "idle"])
  }

  private func cancelRecognition(emitIdle: Bool) {
    requestGeneration += 1
    stopAudioInput()
    recognitionRequest?.endAudio()
    recognitionTask?.cancel()
    recognitionRequest = nil
    recognitionTask = nil
    speechRecognizer = nil
    stopping = false
    lastTranscript = ""
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    if emitIdle {
      sendEvent("onSpeechState", ["state": "idle"])
    }
  }

  private func fail(code: String, message: String) {
    cancelRecognition(emitIdle: false)
    sendEvent("onSpeechError", ["code": code, "message": message])
    sendEvent("onSpeechState", ["state": "error"])
  }
}
