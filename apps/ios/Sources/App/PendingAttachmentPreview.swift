import AVFoundation
import SwiftUI

/// Mirrors the image headers supported by messaging/asset-store.ts. ImageIO can
/// read more formats (and JPEG markers), but those dimensions would disappear
/// when the server returns its metadata. Read headers only, never decoded pixels.
private struct PendingAttachmentMetadata {
  var mimeType: String
  var kind: String
  var width: Int?
  var height: Int?

  init(file: StagedFile, url: URL?) {
    mimeType = file.mimeType
    kind = file.mimeType.hasPrefix("image/") ? "image"
      : file.mimeType.hasPrefix("video/") ? "video"
      : file.mimeType.hasPrefix("audio/") ? "audio" : "file"
    guard let url, let handle = try? FileHandle(forReadingFrom: url) else { return }
    defer { try? handle.close() }
    func read(_ offset: Int, _ count: Int) -> [UInt8] {
      guard (try? handle.seek(toOffset: UInt64(offset))) != nil,
        let data = try? handle.read(upToCount: count) else { return [] }
      return Array(data)
    }
    let bytes = read(0, 30)
    func starts(_ value: String, at offset: Int = 0) -> Bool {
      bytes.dropFirst(offset).starts(with: value.utf8)
    }
    if bytes.starts(with: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
      mimeType = "image/png"
      kind = "image"
      if bytes.count >= 24 {
        width = bytes[16..<20].reduce(0) { ($0 << 8) | Int($1) }
        height = bytes[20..<24].reduce(0) { ($0 << 8) | Int($1) }
      }
    } else if starts("GIF87a") || starts("GIF89a") {
      mimeType = "image/gif"
      kind = "image"
      if bytes.count >= 10 {
        width = Int(bytes[6]) | (Int(bytes[7]) << 8)
        height = Int(bytes[8]) | (Int(bytes[9]) << 8)
      }
    } else if bytes.starts(with: [0xff, 0xd8, 0xff]) {
      mimeType = "image/jpeg"
      kind = "image"
      var offset = 2
      while offset + 9 < file.byteSize {
        let segment = read(offset, 10)
        guard segment.count == 10, segment[0] == 0xff else { return }
        let marker = segment[1]
        offset += 2
        if marker == 0xd8 || marker == 0xd9 { continue }
        let length = (Int(segment[2]) << 8) | Int(segment[3])
        guard length >= 2, offset + length <= file.byteSize else { return }
        if (0xc0...0xc3).contains(marker), length >= 7 {
          height = (Int(segment[5]) << 8) | Int(segment[6])
          width = (Int(segment[7]) << 8) | Int(segment[8])
          return
        }
        offset += length
      }
    } else if starts("RIFF") && starts("WEBP", at: 8) {
      mimeType = "image/webp"
      kind = "image"
      if bytes.count >= 30, starts("VP8X", at: 12) {
        width = 1 + Int(bytes[24]) + (Int(bytes[25]) << 8) + (Int(bytes[26]) << 16)
        height = 1 + Int(bytes[27]) + (Int(bytes[28]) << 8) + (Int(bytes[29]) << 16)
      }
    } else if bytes.count >= 12, starts("ftyp", at: 4) {
      // The server currently treats every ISO media container, including HEIC
      // and AVIF, as video. Match its fixed frame until that contract changes.
      mimeType = "video/mp4"
      kind = "video"
    } else if file.mimeType.hasPrefix("image/") {
      mimeType = "application/octet-stream"
      kind = "file"
    }
  }
}

/// Only the thumbnail survives upload's deletion of the staged original. Opening
/// an uploaded file still fetches its original if the local file has gone away.
@MainActor @Observable final class LocalAttachmentPreview {
  let asset: Asset
  let url: URL?
  private let server: URL?
  private let token: String?
  private var task: Task<UIImage?, Never>?
  private(set) var image: UIImage?

  init(file: StagedFile, url: URL?, api: API?) {
    self.url = url
    server = api?.baseURL
    token = api?.token
    let metadata = PendingAttachmentMetadata(file: file, url: url)
    asset = Asset(assetId: file.id, fileName: file.fileName, mimeType: metadata.mimeType,
      byteSize: file.byteSize, kind: metadata.kind, width: metadata.width, height: metadata.height)
  }

  func matches(_ api: API?) -> Bool { server == api?.baseURL && token == api?.token }

  var file: LoadedAttachment? {
    guard let url, FileManager.default.fileExists(atPath: url.path) else { return nil }
    return LoadedAttachment(url: url, image: image, maximumPixels: 960)
  }

  func load() async {
    guard image == nil, let url else { return }
    if task == nil {
      let asset = asset
      task = Task {
        if asset.mimeType.hasPrefix("video/") {
          let media = ComposerPhoto(url: url, name: asset.fileName, mimeType: asset.mimeType)
          let generator = AVAssetImageGenerator(asset: media.asset)
          generator.appliesPreferredTrackTransform = true
          generator.maximumSize = CGSize(width: 960, height: 960)
          return (try? await generator.image(at: .zero).image).map { UIImage(cgImage: $0) }
        }
        guard asset.mimeType.hasPrefix("image/") else { return nil }
        return (try? await AttachmentImageFile.decode(url, maximumPixels: 960))
          .flatMap { $0 }.map { UIImage(cgImage: $0) }
      }
    }
    image = await task?.value
  }
}

/// A cell can be re-created between upload and ACK. Associate the staged preview
/// with the returned asset while both identities are known, so the accepted row
/// can use it too. Only the uploader's persisted identity mapping can associate
/// them; filenames and sizes are not unique, including within a single send.
@MainActor final class PendingAttachmentPreviews {
  struct Item: Identifiable {
    let asset: Asset
    let local: LocalAttachmentPreview?
    let staged: Bool
    var id: String { asset.assetId + ":" + asset.fileName }
  }
  private var pendingID: String?
  private var server: URL?
  private var token: String?
  private var staged: [LocalAttachmentPreview] = []
  private var uploaded: [String: LocalAttachmentPreview] = [:]

  func items(_ pending: PendingSend, api: API?, fileURL: (StagedFile) -> URL?) -> [Item] {
    if pendingID != pending.id || server != api?.baseURL || token != api?.token {
      pendingID = pending.id
      server = api?.baseURL
      token = api?.token
      staged = []
      uploaded = [:]
    }
    let remaining = pending.stagedFiles ?? []
    for file in remaining where !staged.contains(where: { $0.asset.id == file.id }) {
      staged.append(LocalAttachmentPreview(file: file, url: fileURL(file), api: api))
    }
    var items = pending.input.attachments.map { asset in
      let key = asset.assetId + ":" + asset.fileName
      if uploaded[key] == nil,
        let fileID = pending.uploadedFileIDs?[key],
        let preview = staged.first(where: { $0.asset.id == fileID }) {
        uploaded[key] = preview
        AttachmentPreviewCache.saveLocal(preview, for: asset)
      }
      return Item(asset: asset, local: uploaded[key], staged: false)
    }
    items += remaining.compactMap { file in
      staged.first(where: { $0.asset.id == file.id }).map {
        Item(asset: $0.asset, local: $0, staged: true)
      }
    }
    return items
  }
}

struct StagedAttachmentPreview: View {
  let preview: LocalAttachmentPreview
  var body: some View {
    AttachmentPreview(asset: preview.asset, image: preview.image)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(preview.asset.fileName)
      .accessibilityIdentifier("attachment-" + preview.asset.id)
      .task { await preview.load() }
  }
}
