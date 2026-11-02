import Foundation

extension API {
  func requestAsset(file: URL, fileName: String, mimeType: String) async throws -> Asset {
    var request = URLRequest(url: url("/api/v0/assets"))
    request.httpMethod = "POST"
    request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
    request.setValue(fileName.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "File",
      forHTTPHeaderField: "x-file-name")
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.timeoutIntervalForRequest = 120
    configuration.timeoutIntervalForResource = 900
    let session = URLSession(configuration: configuration, delegate: RedirectPolicy(), delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    let (data, response) = try await session.upload(for: request, fromFile: file)
    guard let response = response as? HTTPURLResponse else { throw APIError("Could not upload this attachment.") }
    guard (200..<300).contains(response.statusCode) else {
      throw APIError("Could not upload this attachment.", status: response.statusCode)
    }
    return try JSONDecoder().decode(Asset.self, from: data)
  }

  func requestAsset(_ data: Data, fileName: String, mimeType: String) async throws -> Asset {
    let (result, _) = try await raw("/api/v0/assets", method: "POST", data: data,
      contentType: mimeType,
      headers: ["x-file-name": fileName.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "File"],
      timeout: 120)
    return try JSONDecoder().decode(Asset.self, from: result)
  }

  /// Stream to disk instead of materializing a video in the intent process.
  func downloadAsset(_ asset: Asset, to destination: URL) async throws {
    var request = URLRequest(url: url("/api/v0/assets/\(Self.segment(asset.assetId))"))
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.timeoutIntervalForResource = 300
    let session = URLSession(configuration: configuration, delegate: RedirectPolicy(), delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    let (file, response) = try await session.download(for: request)
    defer { try? FileManager.default.removeItem(at: file) }
    guard let response = response as? HTTPURLResponse else {
      throw APIError("Could not download this attachment.")
    }
    guard (200..<300).contains(response.statusCode) else {
      throw APIError("Could not download this attachment.", status: response.statusCode)
    }
    try FileManager.default.moveItem(at: file, to: destination)
    #if os(iOS)
      try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete],
        ofItemAtPath: destination.path)
    #endif
  }
}
