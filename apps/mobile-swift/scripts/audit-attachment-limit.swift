import Foundation

@main struct AttachmentLimitAudit {
  static func main() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("native-attachment-audit-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let disk = try DiskStore(directory: directory, scope: "audit-only")
    let bytes = Data(repeating: 0, count: 26 * 1024 * 1024)
    let file = try disk.stage(bytes, fileName: "QA.pdf", mimeType: "application/pdf")
    let api = try API(server: "http://127.0.0.1:20005")
    var status = 0
    var message = ""
    do {
      _ = try await api.raw("/api/v0/assets", method: "POST", data: bytes, contentType: file.mimeType, headers: ["x-file-name": file.fileName])
    } catch let error as APIError {
      status = error.status
      message = error.message
    }
    let report: [String: Any] = ["finding": "QA-11", "fileName": file.fileName, "byteSize": file.byteSize, "acceptedByNativeStaging": true, "productionUploadStatus": status, "productionMessage": message, "expectedRegularLimitBytes": 25 * 1024 * 1024]
    print(String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    guard status == 413 else { throw APIError("The attachment-size mismatch did not reproduce.") }
  }
}
