import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Incremental multipart decoding. A corrupt length/header must never grow a
/// viewer's memory indefinitely or be mistaken for a valid screen image.
public struct ComputerFrameDecoder: Sendable {
  private var buffer = Data()
  private var expected: Int?
  private let boundary: String
  private let maximumBytes: Int
  public init(boundary: String = "openteam-frame", maximumBytes: Int = 8 * 1024 * 1024) {
    self.boundary = boundary
    self.maximumBytes = maximumBytes
  }
  public mutating func append(_ data: Data) throws -> [Data] {
    guard data.count <= maximumBytes * 2 else {
      throw APIError("Computer video chunk is too large.")
    }
    buffer.append(data)
    var frames: [Data] = []
    while true {
      if let count = expected {
        guard buffer.count >= count else { break }
        let frame = Data(buffer.prefix(count))
        guard frame.starts(with: [0xff, 0xd8]), frame.suffix(2) == Data([0xff, 0xd9]) else {
          throw APIError("The computer returned an invalid video frame.")
        }
        frames.append(frame)
        buffer = Data(buffer.dropFirst(count))
        expected = nil
      } else {
        guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
          guard buffer.count <= 4096 else {
            throw APIError("Computer video headers are too large.")
          }
          break
        }
        guard end.upperBound <= 4096,
          let header = String(data: buffer[..<end.lowerBound], encoding: .utf8)
        else { throw APIError("The computer returned invalid video headers.") }
        let lines = header.components(separatedBy: "\r\n").filter { !$0.isEmpty }
        guard lines.first == "--" + boundary else {
          throw APIError("Computer video boundary is invalid.")
        }
        var fields: [String: String] = [:]
        for line in lines.dropFirst() {
          guard let colon = line.firstIndex(of: ":") else {
            throw APIError("Computer video header is invalid.")
          }
          let key = line[..<colon].lowercased()
          guard fields[key] == nil else { throw APIError("Computer video header is duplicated.") }
          fields[key] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        guard fields["content-type"]?.lowercased() == "image/jpeg",
          let length = fields["content-length"], let count = Int(length), count > 0,
          count <= maximumBytes
        else { throw APIError("Computer video frame length or type is invalid.") }
        expected = count
        buffer = Data(buffer[end.upperBound...])
      }
    }
    return frames
  }
}

private final class ComputerFrameReceiver: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  // URLSession invokes all delegate callbacks on its serial operation queue.
  var decoder = ComputerFrameDecoder()
  var decodedParts = false
  var jpeg = Data()
  let continuation: AsyncThrowingStream<Data, Error>.Continuation
  init(_ continuation: AsyncThrowingStream<Data, Error>.Continuation) {
    self.continuation = continuation
  }
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) { completionHandler(nil) }
  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
  ) {
    guard let http = response as? HTTPURLResponse else {
      continuation.finish(throwing: APIError("Computer video response is invalid."))
      completionHandler(.cancel)
      return
    }
    guard http.statusCode == 200 else {
      continuation.finish(
        throwing: APIError(
          UserFacingError.fallback(status: http.statusCode), status: http.statusCode))
      completionHandler(.cancel)
      return
    }
    let type = http.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
    // Apple URLSession may decode multipart framing itself and deliver one
    // image/jpeg response per part. FoundationNetworking delivers raw framing.
    if type.hasPrefix("image/jpeg") {
      guard jpeg.isEmpty else {
        continuation.finish(throwing: APIError("Computer video frame was interrupted."))
        completionHandler(.cancel)
        return
      }
      decodedParts = true
      completionHandler(.allow)
      return
    }
    guard type.contains("multipart/x-mixed-replace"), type.contains("boundary=openteam-frame")
    else {
      continuation.finish(
        throwing: APIError("The server does not support this computer video format."))
      completionHandler(.cancel)
      return
    }
    completionHandler(.allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    do {
      if decodedParts {
        guard jpeg.count + data.count <= 8 * 1024 * 1024 else {
          throw APIError("Computer video frame is too large.")
        }
        jpeg.append(data)
        if jpeg.count >= 2, !jpeg.starts(with: [0xff, 0xd8]) {
          throw APIError("Computer video frame is invalid.")
        }
        if jpeg.count >= 4, jpeg.suffix(2) == Data([0xff, 0xd9]) {
          continuation.yield(jpeg)
          jpeg = Data()
        }
      } else {
        for frame in try decoder.append(data) { continuation.yield(frame) }
      }
    } catch {
      continuation.finish(throwing: error)
      session.invalidateAndCancel()
    }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    continuation.finish(throwing: error ?? APIError("Computer video disconnected. Reconnecting…"))
    session.finishTasksAndInvalidate()
  }
}

extension API {
  /// Only the most recent complete JPEG is queued; slow rendering cannot build a
  /// backlog. Credentials stay on the configured server, never a viewer URL.
  public func computerFrames(_ path: String) -> AsyncThrowingStream<Data, Error> {
    AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
      let configuration = URLSessionConfiguration.ephemeral
      configuration.httpShouldSetCookies = false
      configuration.urlCache = nil
      configuration.timeoutIntervalForRequest = 20
      configuration.timeoutIntervalForResource = 3600
      let receiver = ComputerFrameReceiver(continuation)
      let session = URLSession(configuration: configuration, delegate: receiver, delegateQueue: nil)
      var request = URLRequest(url: url(path))
      request.setValue("multipart/x-mixed-replace", forHTTPHeaderField: "Accept")
      if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
      continuation.onTermination = { @Sendable _ in session.invalidateAndCancel() }
      session.dataTask(with: request).resume()
    }
  }
}
