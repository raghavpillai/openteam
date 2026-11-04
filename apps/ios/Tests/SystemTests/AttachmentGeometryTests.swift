import CryptoKit
import ImageIO
import SwiftUI
import XCTest

@testable import OpenTeamNative

/// Hosted layout checks: no XCUIApplication, server, or authenticated session.
@MainActor final class AttachmentGeometryTests: XCTestCase {
  private var folders: [URL] = []

  override func tearDown() async throws {
    for folder in folders { try? FileManager.default.removeItem(at: folder) }
    folders = []
    AttachmentPreviewCache.clear()
  }

  private func staged(_ data: Data, name: String, mime: String) throws -> (StagedFile, URL) {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    folders.append(folder)
    let file = StagedFile(id: UUID().uuidString, fileName: name, mimeType: mime, byteSize: data.count)
    let url = folder.appendingPathComponent(file.id) // Real staging has no extension.
    try data.write(to: url)
    return (file, url)
  }

  private func photo(width: Int, height: Int, orientation: Int = 1,
    type: String = "public.jpeg") throws -> Data {
    let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height,
      bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    context.setFillColor(UIColor.systemBlue.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
    let data = NSMutableData()
    let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, type as CFString, 1, nil))
    CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()),
      [kCGImagePropertyOrientation: orientation] as CFDictionary)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return data as Data
  }

  private func pending(_ files: [StagedFile], assets: [Asset] = []) -> PendingSend {
    PendingSend(channelId: "fixture", input: SendInput(content: "", attachments: assets), stagedFiles: files)
  }

  private func uploaded(_ file: StagedFile, width: Int? = nil, height: Int? = nil) -> Asset {
    Asset(assetId: "uploaded-" + file.id, fileName: file.fileName, mimeType: file.mimeType,
      byteSize: file.byteSize, kind: file.mimeType.hasPrefix("image/") ? "image"
        : file.mimeType.hasPrefix("video/") ? "video" : "file", width: width, height: height)
  }

  private func completeUpload(_ file: StagedFile, asset: Asset, send: inout PendingSend) {
    send.input.attachments.append(asset)
    send.uploadedFileIDs = send.uploadedFileIDs ?? [:]
    send.uploadedFileIDs?[asset.assetId + ":" + asset.fileName] = file.id
    send.stagedFiles?.removeAll { $0.id == file.id }
  }

  private func measure<V: View>(_ view: V, typeSize: DynamicTypeSize = .large) -> CGSize {
    let host = UIHostingController(rootView: view.environment(AppStore())
      .environment(MessageModalPresenter()).environment(\.dynamicTypeSize, typeSize))
    // Measure the row itself, as UIHostingConfiguration does inside the table.
    host.safeAreaRegions = []
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true; window.rootViewController = nil }
    host.view.frame = window.bounds
    host.view.setNeedsLayout()
    host.view.layoutIfNeeded()
    return host.sizeThatFits(in: CGSize(width: 393, height: 10_000))
  }

  private func assertSame(_ actual: CGSize, _ expected: CGSize,
    file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(actual.width, expected.width, accuracy: 0.5, file: file, line: line)
    XCTAssertEqual(actual.height, expected.height, accuracy: 0.5, file: file, line: line)
  }

  func testPhotoGeometryAcrossUploadAcceptanceAndFailure() throws {
    // Portrait, landscape, small originals, and EXIF-rotated JPEGs. The server
    // reports raw header dimensions, while ImageIO rotates the decoded thumbnail.
    for (width, height, orientation) in [(800, 400, 1), (400, 800, 1), (80, 60, 1), (800, 400, 6)] {
      let (file, url) = try staged(photo(width: width, height: height, orientation: orientation),
        name: "Photo.jpg", mime: "image/jpeg")
      var send = pending([file])
      let previews = PendingAttachmentPreviews()
      _ = previews.items(send, api: nil, fileURL: { _ in url })
      let before = measure(PendingAttachments(pending: send, previews: previews))
      XCTAssertEqual(before.height, min(Double(height), 240, 260 * Double(height) / Double(width)), accuracy: 0.5)
      send.failure = "Upload failed"
      assertSame(measure(PendingAttachments(pending: send, previews: previews)), before)
      let asset = uploaded(file, width: width, height: height)
      completeUpload(file, asset: asset, send: &send)
      // Match the real uploader: delete before the view sees the server asset.
      try FileManager.default.removeItem(at: url)
      assertSame(measure(PendingAttachments(pending: send, previews: previews)), before)
      assertSame(measure(AttachmentView(asset: asset, channelID: send.channelId, messageID: "accepted")), before)
    }
  }

  func testVideoAndDocumentGeometryAcrossUploadAcceptanceAndFailure() throws {
    for (name, mime) in [("Clip.mov", "video/quicktime"),
      ("A very long document filename that must truncate rather than wrap.pdf", "application/pdf")] {
      // Poster availability must have no effect on the video's fixed frame.
      let (file, url) = try staged(Data("fixture".utf8), name: name, mime: mime)
      for typeSize in [DynamicTypeSize.large, .accessibility2] {
        var send = pending([file])
        let previews = PendingAttachmentPreviews()
        _ = previews.items(send, api: nil, fileURL: { _ in url })
        let before = measure(PendingAttachments(pending: send, previews: previews), typeSize: typeSize)
        if mime.hasPrefix("video/") { assertSame(before, CGSize(width: 292, height: 208)) }
        else { XCTAssertGreaterThanOrEqual(before.height, 70) }
        send.failure = "Not delivered"
        assertSame(measure(PendingAttachments(pending: send, previews: previews), typeSize: typeSize), before)
        let asset = uploaded(file)
        completeUpload(file, asset: asset, send: &send)
        assertSame(measure(PendingAttachments(pending: send, previews: previews), typeSize: typeSize), before)
        assertSame(measure(AttachmentView(asset: asset, channelID: send.channelId, messageID: "accepted"),
          typeSize: typeSize), before)
      }
    }
  }

  func testMixedAttachmentsKeepOrderAndGeometryDuringEachUpload() throws {
    let (photoFile, photoURL) = try staged(photo(width: 800, height: 400), name: "Photo.jpg", mime: "image/jpeg")
    let (videoFile, videoURL) = try staged(Data("video".utf8), name: "Clip.mov", mime: "video/quicktime")
    let (document, documentURL) = try staged(Data("%PDF-fixture".utf8), name: "Notes.pdf", mime: "application/pdf")
    let existing = Asset(assetId: "existing", fileName: "Existing.txt", mimeType: "text/plain", byteSize: 100, kind: "file")
    let files = [photoFile, videoFile, document]
    let urls = Dictionary(uniqueKeysWithValues: zip(files.map(\.id), [photoURL, videoURL, documentURL]))
    var send = pending(files, assets: [existing])
    let previews = PendingAttachmentPreviews()
    _ = previews.items(send, api: nil, fileURL: { urls[$0.id] })
    let before = measure(PendingAttachments(pending: send, previews: previews))
    for file in files {
      completeUpload(file, asset: uploaded(file, width: file.id == photoFile.id ? 800 : nil,
        height: file.id == photoFile.id ? 400 : nil), send: &send)
      try FileManager.default.removeItem(at: XCTUnwrap(urls[file.id]))
      let items = previews.items(send, api: nil, fileURL: { urls[$0.id] })
      XCTAssertEqual(items.map { $0.asset.fileName }, ["Existing.txt", "Photo.jpg", "Clip.mov", "Notes.pdf"])
      assertSame(measure(PendingAttachments(pending: send, previews: previews)), before)
    }
    assertSame(measure(VStack(alignment: .trailing, spacing: 5) {
      ForEach(send.input.attachments) { asset in
        AttachmentView(asset: asset, channelID: send.channelId, messageID: "accepted")
      }
    }), before)
  }

  func testThumbnailSurvivesStagedOriginalDeletionAndCacheClears() async throws {
    let (file, url) = try staged(photo(width: 800, height: 400), name: "Photo.jpg", mime: "image/jpeg")
    var send = pending([file])
    let previews = PendingAttachmentPreviews()
    let local = try XCTUnwrap(previews.items(send, api: nil, fileURL: { _ in url }).first?.local)
    let before = measure(PendingAttachments(pending: send, previews: previews))
    await local.load()
    XCTAssertNotNil(local.image)
    assertSame(measure(PendingAttachments(pending: send, previews: previews)), before)
    try FileManager.default.removeItem(at: url)
    let asset = uploaded(file, width: 800, height: 400)
    completeUpload(file, asset: asset, send: &send)
    _ = previews.items(send, api: nil, fileURL: { _ in nil })
    let retained = try XCTUnwrap(AttachmentPreviewCache.local(asset))
    XCTAssertTrue(retained === local)
    XCTAssertNotNil(retained.image)
    XCTAssertNil(retained.file, "A deleted staging path must never be used as the original for Open/Share/Save")
    assertSame(measure(AttachmentView(asset: asset, channelID: send.channelId, messageID: "accepted")), before)
    AttachmentPreviewCache.clear()
    XCTAssertNil(AttachmentPreviewCache.local(asset))
  }

  func testLocalPreviewIsScopedToServerAndAccount() throws {
    let (file, url) = try staged(photo(width: 400, height: 800), name: "Photo.jpg", mime: "image/jpeg")
    let first = try API(server: "https://first.example", token: "fixture-one")
    let second = try API(server: "https://second.example", token: "fixture-one")
    let otherAccount = try API(server: "https://first.example", token: "fixture-two")
    let send = pending([file])
    let previews = PendingAttachmentPreviews()
    let local = try XCTUnwrap(previews.items(send, api: first, fileURL: { _ in url }).first?.local)
    XCTAssertTrue(local.matches(first))
    XCTAssertFalse(local.matches(second))
    XCTAssertFalse(local.matches(otherAccount))
    XCTAssertFalse(local.matches(nil))
    let replacement = try XCTUnwrap(previews.items(send, api: otherAccount, fileURL: { _ in nil }).first?.local)
    XCTAssertFalse(replacement === local)
    XCTAssertNil(replacement.image)
    XCTAssertNil(replacement.url)
  }

  func testSupportedImageHeadersAndNoExtensionPNGMatchServerDimensions() throws {
    for (name, declared, type, detected) in [
      ("Photo.png", "image/png", "public.png", "image/png"),
      ("Photo.gif", "image/gif", "com.compuserve.gif", "image/gif"),
      ("NoExtension", "application/octet-stream", "public.png", "image/png"),
    ] {
      let (file, url) = try staged(photo(width: 80, height: 40, type: type), name: name, mime: declared)
      var send = pending([file])
      let previews = PendingAttachmentPreviews()
      let local = try XCTUnwrap(previews.items(send, api: nil, fileURL: { _ in url }).first?.local)
      XCTAssertEqual(local.asset.mimeType, detected)
      XCTAssertEqual(local.asset.kind, "image")
      XCTAssertEqual(local.asset.width, 80)
      XCTAssertEqual(local.asset.height, 40)
      let before = measure(PendingAttachments(pending: send, previews: previews))
      assertSame(before, CGSize(width: 80, height: 40))
      let asset = Asset(assetId: "uploaded-" + file.id, fileName: name, mimeType: detected,
        byteSize: file.byteSize, kind: "image", width: 80, height: 40)
      completeUpload(file, asset: asset, send: &send)
      try FileManager.default.removeItem(at: url)
      assertSame(measure(PendingAttachments(pending: send, previews: previews)), before)
      assertSame(measure(AttachmentView(asset: asset, channelID: send.channelId, messageID: "accepted")), before)
    }
  }

  func testOrdinaryWebPUsesNilServerDimensionsAcrossUploadAndAcceptance() throws {
    // Real 32×16 lossy VP8 and lossless VP8L images. ImageIO knows their size;
    // asset-store.ts currently reports dimensions only for extended VP8X.
    for base64 in [
      "UklGRkQAAABXRUJQVlA4IDgAAADQAgCdASogABAAPm0skUWkIqGYBABABsSgB2AAEDYAAP75Hdv//kB//kB//kB//ID//iF3sgMAAA==",
      "UklGRhwAAABXRUJQVlA4TA8AAAAvH8ADAAcQ0f/+ByKi/wEA",
    ] {
      let (file, url) = try staged(XCTUnwrap(Data(base64Encoded: base64)), name: "Photo.webp", mime: "image/webp")
      let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
      let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
      XCTAssertEqual(properties[kCGImagePropertyPixelWidth] as? Int, 32)
      XCTAssertEqual(properties[kCGImagePropertyPixelHeight] as? Int, 16)
      var send = pending([file])
      let previews = PendingAttachmentPreviews()
      let local = try XCTUnwrap(previews.items(send, api: nil, fileURL: { _ in url }).first?.local)
      XCTAssertEqual(local.asset.mimeType, "image/webp")
      XCTAssertNil(local.asset.width)
      XCTAssertNil(local.asset.height)
      let before = measure(PendingAttachments(pending: send, previews: previews))
      assertSame(before, CGSize(width: 240, height: 150))
      let asset = uploaded(file)
      completeUpload(file, asset: asset, send: &send)
      try FileManager.default.removeItem(at: url)
      assertSame(measure(PendingAttachments(pending: send, previews: previews)), before)
      assertSame(measure(AttachmentView(asset: asset, channelID: send.channelId, messageID: "accepted")), before)
    }
  }

  func testExtendedWebPAndUnsupportedJPEGMarkersFollowServerHeaderParser() throws {
    // Header fixtures isolate the exact supported chunk/marker contract.
    var extended = Array("RIFF".utf8) + [UInt8](repeating: 0, count: 4)
      + Array("WEBPVP8X".utf8) + [UInt8](repeating: 0, count: 14)
    extended[24] = 31
    extended[27] = 15
    let (webp, webpURL) = try staged(Data(extended), name: "Extended.webp", mime: "image/webp")
    let webpAsset = LocalAttachmentPreview(file: webp, url: webpURL, api: nil).asset
    XCTAssertEqual(webpAsset.width, 32)
    XCTAssertEqual(webpAsset.height, 16)
    // SOF9 is decodable by broader JPEG implementations, but not the server's
    // SOF0–SOF3 parser. Do not reserve a frame from an unsupported marker.
    let (jpeg, jpegURL) = try staged(Data([0xff, 0xd8, 0xff, 0xc9, 0, 11, 8, 0, 16, 0, 32, 0, 0, 0, 0]),
      name: "Unsupported.jpg", mime: "image/jpeg")
    let jpegAsset = LocalAttachmentPreview(file: jpeg, url: jpegURL, api: nil).asset
    XCTAssertEqual(jpegAsset.mimeType, "image/jpeg")
    XCTAssertNil(jpegAsset.width)
    XCTAssertNil(jpegAsset.height)
  }

  func testUnsupportedImageFormatsUseServerPresentationBeforeUpload() throws {
    let tiff = try photo(width: 80, height: 40, type: "public.tiff")
    // Only the ISO container header matters to the server's HEIC/AVIF handling.
    let heic = Data([0, 0, 0, 24] + Array("ftypheic".utf8) + [UInt8](repeating: 0, count: 12))
    let avif = Data([0, 0, 0, 24] + Array("ftypavif".utf8) + [UInt8](repeating: 0, count: 12))
    for (data, name, declared, detected, kind) in [
      (tiff, "Photo.tiff", "image/tiff", "application/octet-stream", "file"),
      (heic, "Photo.heic", "image/heic", "video/mp4", "video"),
      (avif, "Photo.avif", "image/avif", "video/mp4", "video"),
    ] {
      let (file, url) = try staged(data, name: name, mime: declared)
      var send = pending([file])
      let previews = PendingAttachmentPreviews()
      let local = try XCTUnwrap(previews.items(send, api: nil, fileURL: { _ in url }).first?.local)
      XCTAssertEqual(local.asset.mimeType, detected)
      XCTAssertEqual(local.asset.kind, kind)
      XCTAssertNil(local.asset.width)
      XCTAssertNil(local.asset.height)
      let before = measure(PendingAttachments(pending: send, previews: previews))
      let asset = Asset(assetId: "uploaded-" + file.id, fileName: name, mimeType: detected,
        byteSize: file.byteSize, kind: kind)
      completeUpload(file, asset: asset, send: &send)
      try FileManager.default.removeItem(at: url)
      assertSame(measure(PendingAttachments(pending: send, previews: previews)), before)
      assertSame(measure(AttachmentView(asset: asset, channelID: send.channelId, messageID: "accepted")), before)
    }
  }

  func testExistingAssetWithSameFilenameAndSizeCannotClaimUploadedPreview() throws {
    let (file, url) = try staged(photo(width: 80, height: 40), name: "Photo.jpg", mime: "image/jpeg")
    let existing = Asset(assetId: "existing-other-content", fileName: file.fileName,
      mimeType: file.mimeType, byteSize: file.byteSize, kind: "image", width: 80, height: 40)
    var send = pending([file], assets: [existing])
    let previews = PendingAttachmentPreviews()
    let local = try XCTUnwrap(previews.items(send, api: nil, fileURL: { _ in url }).last?.local)
    let asset = uploaded(file, width: 80, height: 40)
    completeUpload(file, asset: asset, send: &send)
    try FileManager.default.removeItem(at: url)
    let items = previews.items(send, api: nil, fileURL: { _ in nil })
    XCTAssertNil(items[0].local)
    XCTAssertNil(AttachmentPreviewCache.local(existing), "The existing asset must download its own image")
    XCTAssertTrue(items[1].local === local)
    XCTAssertTrue(AttachmentPreviewCache.local(asset) === local)
  }

  func testDuplicateFilenamesUseExplicitUploadIdentity() throws {
    let (first, firstURL) = try staged(photo(width: 80, height: 40), name: "Photo.jpg", mime: "image/jpeg")
    let (second, secondURL) = try staged(photo(width: 80, height: 40, orientation: 6),
      name: "Photo.jpg", mime: "image/jpeg")
    let urls = [first.id: firstURL, second.id: secondURL]
    var send = pending([first, second])
    let previews = PendingAttachmentPreviews()
    let stagedItems = previews.items(send, api: nil, fileURL: { urls[$0.id] })
    let firstPreview = try XCTUnwrap(stagedItems[0].local)
    let secondPreview = try XCTUnwrap(stagedItems[1].local)
    // Reverse the association order to ensure array position and names cannot
    // select the preview. Both staged files have disappeared at observation.
    let assets = [uploaded(second, width: 80, height: 40), uploaded(first, width: 80, height: 40)]
    completeUpload(second, asset: assets[0], send: &send)
    completeUpload(first, asset: assets[1], send: &send)
    let items = previews.items(send, api: nil, fileURL: { _ in nil })
    XCTAssertTrue(items[0].local === secondPreview)
    XCTAssertTrue(items[1].local === firstPreview)
    XCTAssertTrue(AttachmentPreviewCache.local(assets[0]) === secondPreview)
    XCTAssertTrue(AttachmentPreviewCache.local(assets[1]) === firstPreview)
  }

  func testIdenticalContentWithDifferentNamesKeepsDistinctItemsAndMappings() throws {
    let bytes = try photo(width: 80, height: 40)
    let (first, firstURL) = try staged(bytes, name: "First.jpg", mime: "image/jpeg")
    let (second, secondURL) = try staged(bytes, name: "Second.jpg", mime: "image/jpeg")
    let urls = [first.id: firstURL, second.id: secondURL]
    var send = pending([first, second])
    let previews = PendingAttachmentPreviews()
    let locals = previews.items(send, api: nil, fileURL: { urls[$0.id] }).map(\.local)
    // The server uses SHA256(bytes) for assetId; filenames do not affect it.
    let contentID = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    let assets = [first, second].map { file in
      Asset(assetId: contentID, fileName: file.fileName, mimeType: "image/jpeg",
        byteSize: bytes.count, kind: "image", width: 80, height: 40)
    }
    completeUpload(first, asset: assets[0], send: &send)
    completeUpload(second, asset: assets[1], send: &send)
    let items = previews.items(send, api: nil, fileURL: { _ in nil })
    XCTAssertEqual(Set(items.map(\.id)).count, 2)
    XCTAssertTrue(items[0].local === locals[0])
    XCTAssertTrue(items[1].local === locals[1])
    XCTAssertEqual(send.uploadedFileIDs?.count, 2)
    XCTAssertTrue(AttachmentPreviewCache.local(assets[0]) === locals[0])
    XCTAssertTrue(AttachmentPreviewCache.local(assets[1]) === locals[1])
  }

  func testUploadMappingPersistsAndLegacySendsDoNotGuessPreviewIdentity() throws {
    let (file, url) = try staged(photo(width: 80, height: 40), name: "Photo.jpg", mime: "image/jpeg")
    var send = pending([file])
    let previews = PendingAttachmentPreviews()
    _ = previews.items(send, api: nil, fileURL: { _ in url })
    let asset = uploaded(file, width: 80, height: 40)
    completeUpload(file, asset: asset, send: &send)
    let disk = try DiskStore(directory: url.deletingLastPathComponent(), scope: "mapping-test")
    var saved = SavedState()
    saved.outbox = [send]
    try disk.save(saved)
    let restored = try XCTUnwrap(disk.load().outbox.first)
    XCTAssertEqual(restored.uploadedFileIDs, [asset.assetId + ":" + asset.fileName: file.id])
    XCTAssertTrue(restored.stagedFiles?.isEmpty == true)

    var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(restored)) as? [String: Any])
    legacy.removeValue(forKey: "uploadedFileIDs")
    let oldSend = try JSONDecoder().decode(PendingSend.self, from: JSONSerialization.data(withJSONObject: legacy))
    XCTAssertNil(oldSend.uploadedFileIDs)
    XCTAssertNil(previews.items(oldSend, api: nil, fileURL: { _ in nil }).first?.local)
    XCTAssertNil(AttachmentPreviewCache.local(asset))
    // After restart even a mapped send has no in-memory thumbnail and must fetch.
    XCTAssertNil(PendingAttachmentPreviews().items(restored, api: nil, fileURL: { _ in nil }).first?.local)
  }
}
