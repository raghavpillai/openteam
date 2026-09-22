#if DEBUG && targetEnvironment(simulator)
  import AVFoundation
  import Foundation

  /// Explicit UI-test audio source for hosts without a microphone. Never compiled into device/release builds.
  /// Writes a real AAC file, so stop/discard/upload/retry exercise the same path as a microphone recording.
  @MainActor final class SimulatorVoiceFixture {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString + ".m4a")
    private var file: AVAudioFile?
    private var source: AVAudioFile?
    private let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
    private var samples = 0
    var elapsed: TimeInterval { Double(samples) / 24_000 }
    init(sourceURL: URL? = nil) throws {
      if let sourceURL {
        let source = try AVAudioFile(forReading: sourceURL)
        guard source.processingFormat.sampleRate == 24_000,
          source.processingFormat.channelCount == 1
        else { throw APIError("QA speech must be a 24 kHz mono recording.") }
        self.source = source
      }
      file = try AVAudioFile(
        forWriting: url,
        settings: [
          AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 24_000, AVNumberOfChannelsKey: 1,
          AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ])
    }
    func append() throws -> CGFloat {
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2_400)!
      buffer.frameLength = 2_400
      var amplitude = 0.15 + 0.12 * sin(elapsed * 5)
      if let source {
        let remaining = max(0, source.length - source.framePosition)
        if remaining > 0 {
          try source.read(into: buffer, frameCount: AVAudioFrameCount(min(2_400, remaining)))
        } else {
          buffer.frameLength = 0
        }
        let read = Int(buffer.frameLength)
        // Preserve real-time capture after the spoken fixture ends.
        for i in read..<2_400 { buffer.floatChannelData![0][i] = 0 }
        buffer.frameLength = 2_400
        amplitude = (0..<2_400).reduce(0.0) {
          max($0, Double(abs(buffer.floatChannelData![0][$1])))
        }
      } else {
        for i in 0..<2_400 {
          buffer.floatChannelData![0][i] = Float(
            amplitude * sin(Double(samples + i) * 2 * .pi * 440 / 24_000))
        }
      }
      try file?.write(from: buffer)
      samples += 2_400
      return CGFloat(amplitude * 3)
    }
    func finish() { file = nil }
  }
#endif
