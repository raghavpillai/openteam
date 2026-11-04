import AVFoundation
import ImageIO
import Photos
import SwiftUI
import UniformTypeIdentifiers

struct LoadedAttachment: Identifiable {
  let url: URL
  let image: UIImage?
  let maximumPixels: Int
  var id: URL { url }

  @MainActor static func fetch(_ asset: Asset, store: AppStore, maximumPixels: Int = 960) async throws -> Self {
    guard let api = store.api else { throw APIError("Connect to your server to open this file.") }
    let (data, _) = try await api.raw("/api/v0/assets/\(API.segment(asset.assetId))")
    try Task.checkCancellation()
    guard store.api?.baseURL == api.baseURL, store.api?.token == api.token else {
      throw CancellationError()
    }
    let url = try await AttachmentImageFile.write(data, named: asset.fileName)
    do {
      let result = try await decode(url, maximumPixels: asset.mimeType.hasPrefix("image/") ? maximumPixels : 0)
      // Re-auth can happen while file preparation runs off the main actor too.
      guard store.api?.baseURL == api.baseURL, store.api?.token == api.token else {
        throw CancellationError()
      }
      return result
    } catch {
      try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
      throw error
    }
  }

  @MainActor static func decode(_ url: URL, maximumPixels: Int) async throws -> Self {
    let decoded = try await AttachmentImageFile.decode(url, maximumPixels: maximumPixels)
    return Self(url: url, image: decoded.map { UIImage(cgImage: $0) }, maximumPixels: maximumPixels)
  }
}

extension LoadedAttachment {
  /// The video's first frame as its preview image.
  func withVideoPoster(side: CGFloat) async -> Self {
    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: side, height: side)
    let poster = (try? await generator.image(at: .zero).image).map { UIImage(cgImage: $0) }
    return Self(url: url, image: poster, maximumPixels: maximumPixels)
  }
}

/// A sent video's first frame, read in byte ranges: AVFoundation asks only for the
/// parts it needs (the index, wherever the file keeps it, and the first frames), so a
/// row no longer downloads the whole video before anyone taps it.
enum VideoPoster {
  @MainActor private static let posters: NSCache<NSString, UIImage> = {
    let cache = NSCache<NSString, UIImage>()
    cache.totalCostLimit = 24 * 1024 * 1024
    return cache
  }()
  @MainActor static func cached(_ asset: Asset) -> UIImage? { posters.object(forKey: asset.assetId as NSString) }
  @MainActor static func clear() { posters.removeAllObjects() }

  @MainActor static func load(_ asset: Asset, store: AppStore, side: CGFloat) async -> UIImage? {
    if let poster = cached(asset) { return poster }
    guard let api = store.api, asset.byteSize > 0 else { return nil }
    let loader = RangedAssetLoader(api: api, path: "/api/v0/assets/\(API.segment(asset.assetId))",
      byteSize: Int64(asset.byteSize), mimeType: asset.mimeType)
    let video = AVURLAsset(url: URL(string: "openteam-asset://video/\(asset.assetId)")!)
    video.resourceLoader.setDelegate(loader, queue: RangedAssetLoader.queue)
    let generator = AVAssetImageGenerator(asset: video)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: side, height: side)
    let frame = try? await generator.image(at: .zero).image
    withExtendedLifetime(loader) {}
    guard let frame, store.api?.token == api.token else { return nil }
    let poster = UIImage(cgImage: frame)
    posters.setObject(poster, forKey: asset.assetId as NSString, cost: frame.width * frame.height * 4)
    return poster
  }
}

/// Serves AVFoundation's reads of a server asset with authenticated Range requests.
final class RangedAssetLoader: NSObject, AVAssetResourceLoaderDelegate, Sendable {
  static let queue = DispatchQueue(label: "openteam.ranged-asset")
  /// AVFoundation asks again for whatever a shorter answer leaves out.
  private static let chunk: Int64 = 512 * 1024
  let api: API
  let path: String
  let byteSize: Int64
  let contentType: String
  init(api: API, path: String, byteSize: Int64, mimeType: String) {
    self.api = api
    self.path = path
    self.byteSize = byteSize
    contentType = UTType(mimeType: mimeType)?.identifier ?? UTType.mpeg4Movie.identifier
  }
  func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
    shouldWaitForLoadingOfRequestedResource request: AVAssetResourceLoadingRequest) -> Bool {
    if let information = request.contentInformationRequest {
      information.contentType = contentType
      information.contentLength = byteSize
      information.isByteRangeAccessSupported = true
    }
    guard let data = request.dataRequest else { request.finishLoading(); return true }
    let start = data.currentOffset
    let wanted = data.requestsAllDataToEndOfResource ? byteSize - start
      : Int64(data.requestedLength) - (start - data.requestedOffset)
    let end = min(byteSize, start + min(max(wanted, 1), Self.chunk)) - 1
    guard start <= end else { request.finishLoading(); return true }
    let api = api, path = path
    nonisolated(unsafe) let loading = request
    Task {
      do {
        let (bytes, response) = try await api.raw(path, headers: ["Range": "bytes=\(start)-\(end)"])
        guard !loading.isCancelled else { return }
        // A server that ignores Range sends the whole file; answer with the asked-for part.
        let part = response.statusCode == 206 ? bytes
          : bytes.subdata(in: Int(min(start, Int64(bytes.count)))..<Int(min(end + 1, Int64(bytes.count))))
        loading.dataRequest?.respond(with: part)
        loading.finishLoading()
      } catch {
        if !loading.isCancelled { loading.finishLoading(with: error) }
      }
    }
    return true
  }
}

/// Decoded chat previews survive cell recycling. A photo scrolled back into view
/// is drawn in its row's first layout, instead of flashing a placeholder while
/// the original downloads and decodes again. Cleared with the account's data.
@MainActor enum AttachmentPreviewCache {
  private final class Entry {
    let value: LoadedAttachment
    init(_ value: LoadedAttachment) { self.value = value }
  }
  private static let values: NSCache<NSString, Entry> = {
    let cache = NSCache<NSString, Entry>()
    cache.totalCostLimit = 48 * 1024 * 1024
    return cache
  }()
  private static func key(_ asset: Asset) -> NSString { (asset.assetId + ":" + asset.fileName) as NSString }
  static func value(_ asset: Asset) -> LoadedAttachment? { values.object(forKey: key(asset))?.value }
  static func save(_ value: LoadedAttachment, for asset: Asset) {
    let cost = value.image.map { Int($0.size.width * $0.size.height * $0.scale * $0.scale * 4) } ?? 0
    values.setObject(Entry(value), forKey: key(asset), cost: cost)
  }
  static func clear() { values.removeAllObjects() }
}

struct GalleryItem: Identifiable {
  let id: String
  let asset: Asset
  let caption: String
}

struct AttachmentView: View {
  @Environment(MessageModalPresenter.self) private var modals
  @Environment(AppStore.self) private var store
  let asset: Asset
  let channelID: String
  let messageID: String
  @State private var loaded: LoadedAttachment?
  @State private var poster: UIImage?
  @State private var loading = false
  @State private var failure: String?
  init(asset: Asset, channelID: String, messageID: String) {
    self.asset = asset
    self.channelID = channelID
    self.messageID = messageID
    _loaded = State(initialValue: AttachmentPreviewCache.value(asset))
    _poster = State(initialValue: asset.mimeType.hasPrefix("video/") ? VideoPoster.cached(asset) : nil)
  }
  private var isImage: Bool { asset.mimeType.hasPrefix("image/") }
  private var isVideo: Bool { asset.mimeType.hasPrefix("video/") }
  /// Videos sit whole in a fixed black frame, letterboxed like the reference; photos take their own shape.
  private var previewSize: CGSize {
    isVideo ? CGSize(width: 292, height: 208) : AttachmentImageFile.previewSize(width: asset.width, height: asset.height)
  }
  private var galleryID: String { messageID + ":" + asset.id + ":" + asset.fileName }
  private var gallery: [GalleryItem] {
    let items = store.messages(channelID).flatMap { message in
      message.attachments.filter { $0.mimeType.hasPrefix("image/") }.map { attachment in
        GalleryItem(id: message.id + ":" + attachment.id + ":" + attachment.fileName,
          asset: attachment, caption: attachment.alt ?? message.displayContent)
      }
    }
    return items.contains(where: { $0.id == galleryID }) ? items : [GalleryItem(id: galleryID, asset: asset, caption: asset.alt ?? "")]
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        NativeHaptics.play(.light, source: "attachment.open")
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        if isImage {
          modals.fullScreen = .init(content: AnyView(NativePhotoGallery(
            items: gallery, initialID: galleryID, initialFile: loaded)))
        } else { Task { await load(open: true) } }
      } label: {
        if isImage || isVideo {
          ZStack {
            if isVideo { Color.black } else { NativePalette.surface }
            if let image = isVideo ? poster ?? loaded?.image : loaded?.image {
              if isVideo {
                Image(uiImage: image).resizable().scaledToFit()
                  .frame(width: previewSize.width, height: previewSize.height)
              } else {
                Image(uiImage: image).resizable().scaledToFill()
                  .frame(width: previewSize.width, height: previewSize.height).clipped()
              }
            } else if failure != nil && isImage {
              Label("Image unavailable", systemImage: "arrow.clockwise").font(.caption)
                .foregroundStyle(NativePalette.muted)
            } else if loading { LoadingOrb(label: "Loading image") }
            else if isImage { Image(systemName: "photo").foregroundStyle(NativePalette.muted) }
            if isVideo {
              Group {
                if loading && loaded == nil { LoadingOrb(size: 22, label: "Opening") }
                else {
                  Image(systemName: "play.fill").font(.system(size: 20)).foregroundStyle(.white).offset(x: 1.5)
                }
              }
              .frame(width: 52, height: 52)
              .modifier(NativeGlass(radius: 26, darkTint: 0.1))
              .environment(\.colorScheme, .dark)
            }
          }.frame(width: previewSize.width, height: previewSize.height)
            .clipShape(RoundedRectangle(cornerRadius: 16))
        } else {
          HStack(spacing: 14) {
            FileGlyph(kind: fileKind).frame(width: 34, height: 42)
            VStack(alignment: .leading, spacing: 3) {
              Text(asset.fileName).font(.body).foregroundStyle(NativePalette.text)
                .lineLimit(1).truncationMode(.middle)
              Text(loading ? "Opening…" : fileDetail)
                .font(.subheadline).foregroundStyle(NativePalette.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
            if loading { LoadingOrb(size: 16, label: "Opening") }
          }.padding(.leading, 16).padding(.trailing, 18).padding(.vertical, 14)
            .containerRelativeFrame(.horizontal, alignment: .leading) { width, _ in min(width * 0.8, 340) }
            .dynamicTypeSize(...DynamicTypeSize.accessibility2)
            .background(NativePalette.background, in: RoundedRectangle(cornerRadius: 26))
            .overlay(RoundedRectangle(cornerRadius: 26).strokeBorder(NativePalette.separator, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 26))
        }
      }.buttonStyle(.plain).disabled(loading && !isImage)
        .accessibilityLabel((isVideo ? "Play " : "Open ") + asset.fileName)
        .accessibilityValue(failure != nil ? "Failed" : loaded != nil || poster != nil ? "Loaded" : "Loading")
        .accessibilityIdentifier("attachment-" + asset.id)
      if let failure, !isImage { InlineFailure(message: failure) { Task { await load(open: true) } } }
    }
    .task(id: asset.id) {
      if isImage { await load(open: false) }
      else if isVideo, poster == nil {
        poster = await VideoPoster.load(asset, store: store, side: max(previewSize.width, previewSize.height) * 3)
      }
    }
  }
  private var fileExtension: String { (asset.fileName as NSString).pathExtension.lowercased() }
  private var fileKind: FileGlyph.Kind {
    if asset.mimeType == "application/pdf" || fileExtension == "pdf" { return .pdf }
    if ["zip", "tar", "gz", "7z", "rar"].contains(fileExtension) { return .archive }
    if fileExtension.isEmpty && ["", "application/octet-stream"].contains(asset.mimeType) { return .unknown }
    return .document
  }
  /// "PDF · 818 KB", or just the size when the file has no type.
  private var fileDetail: String {
    fileKind == .unknown || fileExtension.isEmpty ? fileSize : fileExtension.uppercased() + " · " + fileSize
  }
  private var fileSize: String {
    let bytes = Double(asset.byteSize)
    let unit: (Double, String) = bytes >= 1_000_000 ? (1_000_000, "MB") : (1_000, "KB")
    guard bytes >= 1_000 else { return "\(asset.byteSize) bytes" }
    let value = bytes / unit.0
    return value.formatted(.number.precision(.fractionLength(value < 10 ? 1 : 0))) + " " + unit.1
  }
  private func presentFile(_ file: LoadedAttachment?) {
    guard let file else { return }
    if isVideo {
      modals.fullScreen = .init(content: AnyView(
        ComposerVideoViewer(video: ComposerPhoto(url: file.url, name: asset.fileName, mimeType: asset.mimeType))
          .preferredColorScheme(.dark)))
      return
    }
    modals.sheet = .init(content: AnyView(NativeFilePreview(url: file.url, mimeType: asset.mimeType)))
  }
  private func load(open: Bool) async {
    guard !loading else { return }
    if let loaded { if open { presentFile(loaded) }; return }
    loading = true
    defer { loading = false }
    do {
      var file = try await LoadedAttachment.fetch(asset, store: store)
      guard !isImage || file.image != nil else { throw APIError("This image could not be loaded.") }
      if isVideo { file = await file.withVideoPoster(side: max(previewSize.width, previewSize.height) * 3) }
      if isImage || isVideo { AttachmentPreviewCache.save(file, for: asset) }
      loaded = file
      failure = nil
      if open { presentFile(loaded) }
    } catch {
      if !UserFacingError.isCancelled(error) { failure = UserFacingError.message(error) }
      if (error as? APIError)?.unauthorized == true { store.handle(error) }
    }
  }
}

struct NativePhotoGallery: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  let items: [GalleryItem]
  @State private var selected: String
  @State private var files: [String: LoadedAttachment]
  @State private var sourceURLs: [String: URL]
  @State private var sourceTasks: [String: Task<URL, Error>] = [:]
  @State private var thumbnails: [String: UIImage] = [:]
  @State private var thumbnailLoading = Set<String>()
  @State private var loading = Set<String>()
  @State private var failures: [String: String] = [:]
  @State private var sharing = false
  @State private var forwarding = false
  @State private var saving = false
  @State private var saved = false
  @State private var actionError: String?
  init(items: [GalleryItem], initialID: String, initialFile: LoadedAttachment?) {
    self.items = items
    _selected = State(initialValue: initialID)
    _files = State(initialValue: initialFile.map { [initialID: $0] } ?? [:])
    _sourceURLs = State(initialValue: initialFile.map { [initialID: $0.url] } ?? [:])
  }
  private var current: GalleryItem? { items.first { $0.id == selected } }
  var body: some View {
    VStack(spacing: 0) {
      HStack {
        ChromeButton(title: "Close", symbol: "xmark", darkTint: 0.06) { dismiss() }.accessibilityIdentifier("photo-close")
        Spacer()
        NativeActionMenu(symbol: "ellipsis", darkTint: 0.07, title: "Photo options",
          identifier: "photo-options", panelIdentifier: "photo-menu-panel",
          hapticSource: "attachment.options", color: .white, actions: [
            .init(title: "Forward", symbol: "arrowshape.turn.up.right", action: {
              NativeHaptics.play(.light, source: "attachment.forward")
              forwarding = true
            }),
            .init(title: "Share", symbol: "square.and.arrow.up", enabled: files[selected] != nil, action: {
              NativeHaptics.play(.light, source: "attachment.share")
              sharing = true
            }),
            .init(title: saving ? "Saving…" : "Save", symbol: "arrow.down.to.line",
              enabled: files[selected]?.image != nil && !saving, action: { Task { await savePhoto() } }),
          ]).frame(width: 44, height: 44).nativeGlass(darkTint: 0.06)
      }.padding(.horizontal, 18).padding(.top, 6)
      TabView(selection: $selected) {
        ForEach(items) { item in
          ZStack {
            if let image = files[item.id]?.image {
              ZoomablePhoto(image: image).padding(.horizontal, 16)
                .accessibilityLabel(item.caption.isEmpty ? item.asset.fileName : item.caption)
                .accessibilityIdentifier("photo-image-" + item.asset.id)
            } else if let failure = failures[item.id] {
              VStack(spacing: 14) {
                Text(failure).multilineTextAlignment(.center).foregroundStyle(NativePalette.muted)
                Button("Retry") { Task { await load(item) } }.accessibilityIdentifier("photo-retry")
              }.padding(24)
            } else { LoadingOrb(theme: .dark, label: "Loading photo") }
          }.padding(.bottom, 18).frame(maxWidth: .infinity, maxHeight: .infinity).tag(item.id).task { await load(item) }
        }
      }.tabViewStyle(.page(indexDisplayMode: .never)).frame(maxWidth: .infinity, maxHeight: .infinity)
      VStack(spacing: 20) {
        if let caption = current?.caption, !caption.isEmpty {
          Text(caption).font(.system(size: 15)).foregroundStyle(Color(white: 0.72))
            .multilineTextAlignment(.center).lineLimit(2).padding(.horizontal, 20)
            .accessibilityIdentifier("photo-caption")
        }
        if items.count > 1 {
          GeometryReader { geometry in
          ScrollViewReader { proxy in
            ScrollView(.horizontal) {
              LazyHStack(spacing: 7) {
                ForEach(items) { item in
                  Button {
                    NativeHaptics.play(.selection, source: "attachment.photo-selection")
                    selected = item.id
                  } label: {
                    ZStack {
                      Color(white: 0.15)
                      if let image = thumbnails[item.id] { Image(uiImage: image).resizable().scaledToFill() }
                      if item.id != selected { Color.black.opacity(0.48) }
                    }.frame(width: 48, height: 48).clipShape(RoundedRectangle(cornerRadius: 9))
                      .overlay { if item.id == selected { RoundedRectangle(cornerRadius: 9).stroke(.white, lineWidth: 2) } }
                  }.buttonStyle(.plain).padding(.vertical, 2).id(item.id)
                    .accessibilityLabel("Photo \((items.firstIndex { $0.id == item.id } ?? 0) + 1)")
                    .accessibilityIdentifier("photo-thumbnail-" + item.asset.id)
                    .accessibilityAddTraits(item.id == selected ? .isSelected : [])
                    .task { await loadThumbnail(item) }
                }
              }.padding(.horizontal, max(16, (geometry.size.width - 48) / 2))
            }.scrollIndicators(.hidden).frame(height: 52)
              .accessibilityIdentifier("photo-filmstrip")
              .onAppear { proxy.scrollTo(selected, anchor: .center) }
              .onChange(of: selected) { _, id in withAnimation { proxy.scrollTo(id, anchor: .center) } }
          }
          }.frame(height: 52)
        }
      }.fixedSize(horizontal: false, vertical: true).padding(.bottom, 8)
    }.background(Color.black.ignoresSafeArea()).preferredColorScheme(.dark)
      .ignoresSafeArea(.keyboard)
      .onAppear { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
      .onChange(of: selected) { _, id in
        if let item = items.first(where: { $0.id == id }) { Task { await load(item) } }
      }
      .onDisappear { for task in sourceTasks.values { task.cancel() } }
      .foregroundStyle(.white)
      .sheet(isPresented: $sharing) {
        if let file = files[selected] { NativeFileShare(url: file.url) { actionError = UserFacingError.message($0) } }
      }
      .sheet(isPresented: $forwarding) {
        if let current { ForwardAttachmentView(asset: current.asset).referenceSheet() }
      }
      .alert(actionError == nil ? "Saved to Photos" : "Couldn’t complete action",
        isPresented: Binding(get: { saved || actionError != nil }, set: { if !$0 { saved = false; actionError = nil } })) {
        Button("OK", role: .cancel) { saved = false; actionError = nil }
      } message: { Text(actionError ?? "") }
  }
  private func load(_ item: GalleryItem) async {
    // The inline preview opens immediately, then upgrades from the same local
    // original. Previously that 960-pixel preview prevented a gallery decode.
    guard (files[item.id]?.maximumPixels ?? 0) < 2048, loading.insert(item.id).inserted else { return }
    defer { loading.remove(item.id) }
    do {
      let url = try await sourceURL(item)
      let file = try await LoadedAttachment.decode(url, maximumPixels: 2048)
      guard file.image != nil else {
        sourceURLs[item.id] = nil
        throw APIError("This image could not be loaded.")
      }
      files[item.id] = file
      failures[item.id] = nil
      // Keep long photo histories from retaining every decoded full-size image.
      let center = items.firstIndex { $0.id == selected } ?? 0
      let closest = items.enumerated().sorted { abs($0.offset - center) < abs($1.offset - center) }
        .map(\.element.id).filter { files[$0] != nil }.prefix(12)
      let retained = Set(closest)
      files = files.filter { retained.contains($0.key) }
    } catch {
      if !UserFacingError.isCancelled(error) { failures[item.id] = UserFacingError.message(error) }
      if (error as? APIError)?.unauthorized == true { store.handle(error) }
    }
  }
  private func sourceURL(_ item: GalleryItem) async throws -> URL {
    if let url = sourceURLs[item.id] { return url }
    if let task = sourceTasks[item.id] { return try await task.value }
    // Page and filmstrip requests share one download. Decoded page eviction
    // keeps the original on disk so returning to an older photo works offline.
    let task = Task { try await LoadedAttachment.fetch(item.asset, store: store, maximumPixels: 0).url }
    sourceTasks[item.id] = task
    defer { sourceTasks[item.id] = nil }
    let url = try await task.value
    sourceURLs[item.id] = url
    return url
  }
  private func loadThumbnail(_ item: GalleryItem) async {
    guard thumbnails[item.id] == nil, thumbnailLoading.insert(item.id).inserted else { return }
    defer { thumbnailLoading.remove(item.id) }
    do {
      let url = try await sourceURL(item)
      let thumbnail = try await LoadedAttachment.decode(url, maximumPixels: 144)
      thumbnails[item.id] = thumbnail.image
    } catch {
      if (error as? APIError)?.unauthorized == true { store.handle(error) }
    }
  }
  private func savePhoto() async {
    guard let file = files[selected], !saving else { return }
    saving = true
    defer { saving = false }
    NativeHaptics.play(.light, source: "attachment.save")
    do {
      let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
      guard status == .authorized || status == .limited else {
        throw APIError("Allow OpenTeam to add photos in iPhone Settings, then try again.")
      }
      try await PhotoLibraryWriter.save(file.url)
      NativeHaptics.play(.success, source: "attachment.save")
      saved = true
    } catch {
      NativeHaptics.failure(error, source: "attachment.save")
      actionError = UserFacingError.message(error)
    }
  }
}

private enum PhotoLibraryWriter {
  // Photos executes this transaction on its own queue, never the UI actor.
  nonisolated static func save(_ url: URL) async throws {
    try await PHPhotoLibrary.shared().performChanges { @Sendable in
      PHAssetCreationRequest.forAsset().addResource(with: .photo, fileURL: url, options: nil)
    }
  }
}

private struct ZoomablePhoto: UIViewRepresentable {
  let image: UIImage
  func makeUIView(context: Context) -> PhotoScrollView { PhotoScrollView(image: image) }
  func updateUIView(_ view: PhotoScrollView, context: Context) { view.updateImage(image) }
}

private final class PhotoScrollView: UIScrollView, UIScrollViewDelegate {
  private let photo: UIImageView
  init(image: UIImage) {
    photo = UIImageView(image: image)
    super.init(frame: .zero)
    delegate = self
    minimumZoomScale = 1
    maximumZoomScale = 5
    showsVerticalScrollIndicator = false
    showsHorizontalScrollIndicator = false
    contentInsetAdjustmentBehavior = .never
    photo.contentMode = .scaleAspectFit
    photo.layer.cornerRadius = 12
    photo.clipsToBounds = true
    addSubview(photo)
    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
    doubleTap.numberOfTapsRequired = 2
    addGestureRecognizer(doubleTap)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  func updateImage(_ image: UIImage) {
    guard photo.image !== image else { return }
    photo.image = image
    setNeedsLayout()
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    if zoomScale == 1, let image = photo.image, bounds.width > 0, bounds.height > 0 {
      let scale = min(bounds.width / image.size.width, bounds.height / image.size.height)
      photo.frame = CGRect(origin: .zero, size: CGSize(width: image.size.width * scale, height: image.size.height * scale))
      contentSize = photo.bounds.size
    }
    photo.center = CGPoint(x: max(bounds.width, contentSize.width) / 2, y: max(bounds.height, contentSize.height) / 2)
  }
  func viewForZooming(in scrollView: UIScrollView) -> UIView? { photo }
  @objc private func toggleZoom(_ recognizer: UITapGestureRecognizer) {
    if zoomScale > 1 { setZoomScale(1, animated: true) }
    else {
      let point = recognizer.location(in: photo)
      zoom(to: CGRect(x: point.x - bounds.width / 4, y: point.y - bounds.height / 4, width: bounds.width / 2, height: bounds.height / 2), animated: true)
    }
  }
}

private struct ForwardAttachmentView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  let asset: Asset
  @State private var selected: String?
  @State private var sending = false
  @State private var failure: String?
  var body: some View {
    NavigationStack {
      NativeList {
        Section { Text(asset.fileName).foregroundStyle(NativePalette.muted) }
        if let failure { InlineFailure(message: failure) }
        ForEach(store.channels.filter { $0.kind != "agent_dm" }) { channel in
          Button { selected = channel.id } label: {
            HStack {
              ChannelAvatar(channel: channel, size: 32)
              Text(channel.name).foregroundStyle(NativePalette.text)
              Spacer()
              if selected == channel.id { Image(systemName: "checkmark").foregroundStyle(NativePalette.link) }
            }
          }.accessibilityIdentifier("forward-to-" + channel.id)
        }
      }.navigationTitle("Forward").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button(sending ? "Forwarding…" : "Forward") {
              Task {
                guard let id = selected, let channel = store.channel(id), !sending else { return }
                sending = true
                defer { sending = false }
                do { try await store.forwardAttachment(asset, to: channel); dismiss() }
                catch { failure = UserFacingError.message(error) }
              }
            }.disabled(selected == nil || sending).accessibilityIdentifier("forward-confirm")
          }
        }
    }.interactiveDismissDisabled(sending)
  }
}

/// A page with a folded corner, marked by what the file is: a red band for PDFs,
/// a question mark when the file has no type.
struct FileGlyph: View {
  enum Kind { case pdf, archive, document, unknown }
  let kind: Kind

  var body: some View {
    GeometryReader { proxy in
      let width = proxy.size.width, height = proxy.size.height
      ZStack(alignment: .topLeading) {
        FoldedPage(fold: width * 0.34).fill(Color(.systemGray4))
        switch kind {
        case .pdf:
          FoldedPage(fold: width * 0.34).fill(Color(hex: "D0393E"))
            .mask(alignment: .bottom) { Rectangle().frame(height: height * 0.3) }
          lines(width: width, height: height, rows: 2)
          RoundedRectangle(cornerRadius: 2).fill(Color(.systemGray))
            .frame(width: width * 0.34, height: height * 0.18)
            .offset(x: width * 0.48, y: height * 0.36)
        case .archive:
          VStack(spacing: height * 0.05) {
            ForEach(0..<4, id: \.self) { _ in Rectangle().fill(Color(.systemGray)).frame(width: width * 0.14, height: height * 0.06) }
          }.frame(width: width).offset(y: height * 0.12)
        case .document:
          lines(width: width, height: height, rows: 4)
        case .unknown:
          Text("?").font(.system(size: height * 0.42, weight: .regular)).foregroundStyle(Color(.systemGray))
            .frame(width: width, height: height).offset(y: height * 0.05)
        }
      }
    }
    .accessibilityHidden(true)
  }

  private func lines(width: CGFloat, height: CGFloat, rows: Int) -> some View {
    VStack(alignment: .leading, spacing: height * 0.07) {
      ForEach(0..<rows, id: \.self) { row in
        Capsule().fill(Color(.systemGray))
          .frame(width: width * (row == 0 ? 0.36 : rows == 2 ? 0.28 : 0.62), height: height * 0.055)
      }
    }.offset(x: width * 0.14, y: height * 0.3)
  }
}

private struct FoldedPage: Shape {
  let fold: CGFloat
  func path(in rect: CGRect) -> Path {
    let radius = rect.width * 0.12
    var path = Path()
    path.move(to: CGPoint(x: rect.minX + radius, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX - fold, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + fold))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - radius))
    path.addQuadCurve(to: CGPoint(x: rect.maxX - radius, y: rect.maxY), control: CGPoint(x: rect.maxX, y: rect.maxY))
    path.addLine(to: CGPoint(x: rect.minX + radius, y: rect.maxY))
    path.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.maxY - radius), control: CGPoint(x: rect.minX, y: rect.maxY))
    path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + radius))
    path.addQuadCurve(to: CGPoint(x: rect.minX + radius, y: rect.minY), control: CGPoint(x: rect.minX, y: rect.minY))
    path.closeSubpath()
    return path
  }
}
