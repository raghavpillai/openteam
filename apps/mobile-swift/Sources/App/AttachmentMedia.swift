import ImageIO
import Photos
import SwiftUI

struct LoadedAttachment: Identifiable {
  let url: URL
  let image: UIImage?
  var id: URL { url }

  @MainActor static func fetch(_ asset: Asset, store: AppStore, maximumPixels: Int = 960) async throws -> Self {
    guard let api = store.api else { throw APIError("Connect to your server to open this file.") }
    let (data, _) = try await api.raw("/api/v0/assets/\(API.segment(asset.assetId))")
    try Task.checkCancellation()
    guard store.api?.baseURL == api.baseURL, store.api?.token == api.token else {
      throw CancellationError()
    }
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let leaf = URL(fileURLWithPath: asset.fileName).lastPathComponent
    let url = folder.appendingPathComponent(leaf.isEmpty || [".", "..", "/"].contains(leaf) ? "Attachment" : leaf)
    try data.write(to: url, options: [.atomic, .completeFileProtection])
    var image: UIImage?
    if asset.mimeType.hasPrefix("image/"),
      let source = CGImageSourceCreateWithData(data as CFData, nil),
      let decoded = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceThumbnailMaxPixelSize: maximumPixels,
        kCGImageSourceCreateThumbnailWithTransform: true,
      ] as CFDictionary) {
      image = UIImage(cgImage: decoded)
    }
    return Self(url: url, image: image)
  }
}

struct GalleryItem: Identifiable {
  let id: String
  let asset: Asset
  let caption: String
}

struct AttachmentView: View {
  @Environment(AppStore.self) private var store
  let asset: Asset
  let channelID: String
  let messageID: String
  @State private var loaded: LoadedAttachment?
  @State private var loading = false
  @State private var failure: String?
  @State private var preview: LoadedAttachment?
  @State private var galleryPresented = false
  private var isImage: Bool { asset.mimeType.hasPrefix("image/") }
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
        if isImage { galleryPresented = true } else { Task { await load(open: true) } }
      } label: {
        if isImage {
          if let image = loaded?.image {
            Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: 260, maxHeight: 240)
              .clipShape(RoundedRectangle(cornerRadius: 16))
          } else {
            ZStack {
              RoundedRectangle(cornerRadius: 16).fill(NativePalette.surface)
              if loading { ProgressView() } else { Image(systemName: "photo").foregroundStyle(NativePalette.muted) }
            }.frame(width: 240, height: 150)
          }
        } else {
          HStack(spacing: 10) {
            Image(systemName: archive ? "archivebox" : "doc")
              .font(.system(size: 16)).foregroundStyle(archive ? Color(hex: "C9A333") : NativePalette.muted)
              .frame(width: 28, height: 28).background(NativePalette.selection, in: RoundedRectangle(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 3) {
              fileName.font(.system(size: 16, weight: .medium)).lineLimit(1).truncationMode(.middle)
              Text(loading ? "Opening…" : fileSize)
                .font(.system(size: 12)).foregroundStyle(NativePalette.faint)
            }
            if loading { ProgressView().controlSize(.small) }
          }.padding(.horizontal, 13).padding(.vertical, 10)
            .background(NativePalette.assistant, in: RoundedRectangle(cornerRadius: 20))
        }
      }.buttonStyle(.plain).disabled(loading && !isImage)
        .accessibilityLabel("Open " + asset.fileName).accessibilityIdentifier("attachment-" + asset.id)
      if let failure { InlineFailure(message: failure) { Task { await load(open: !isImage) } } }
    }
    .sheet(item: $preview) { file in
      NativeFilePreview(url: file.url, mimeType: asset.mimeType)
    }
    .fullScreenCover(isPresented: $galleryPresented) {
      NativePhotoGallery(items: gallery, initialID: galleryID, initialFile: loaded)
    }
    .task(id: asset.id) { if isImage { await load(open: false) } }
  }
  private var archive: Bool {
    ["zip", "tar", "gz", "7z", "rar"].contains((asset.fileName as NSString).pathExtension.lowercased())
  }
  private var fileSize: String {
    let bytes = Double(asset.byteSize)
    let unit: (Double, String) = bytes >= 1_000_000 ? (1_000_000, "MB") : (1_000, "KB")
    guard bytes >= 1_000 else { return "\(asset.byteSize) bytes" }
    let value = bytes / unit.0
    return value.formatted(.number.precision(.fractionLength(value < 10 ? 1 : 0))) + " " + unit.1
  }
  private var fileName: Text {
    let name = asset.fileName as NSString
    guard !name.pathExtension.isEmpty else { return Text(asset.fileName).foregroundColor(NativePalette.text) }
    return Text(name.deletingPathExtension).foregroundColor(NativePalette.text)
      + Text("." + name.pathExtension).foregroundColor(NativePalette.faint)
  }
  private func load(open: Bool) async {
    guard !loading else { return }
    if let loaded { if open { preview = loaded }; return }
    loading = true
    defer { loading = false }
    do {
      let file = try await LoadedAttachment.fetch(asset, store: store)
      guard !isImage || file.image != nil else { throw APIError("This image could not be loaded.") }
      loaded = file
      failure = nil
      if open { preview = loaded }
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
  }
  private var current: GalleryItem? { items.first { $0.id == selected } }
  var body: some View {
    VStack(spacing: 0) {
      HStack {
        ChromeButton(title: "Close", symbol: "xmark", darkTint: 0.06) { dismiss() }.accessibilityIdentifier("photo-close")
        Spacer()
        Menu {
          Button("Forward", systemImage: "arrowshape.turn.up.right") {
            NativeHaptics.play(.light, source: "attachment.forward")
            forwarding = true
          }
          Button("Share", systemImage: "square.and.arrow.up") {
            NativeHaptics.play(.light, source: "attachment.share")
            sharing = true
          }.disabled(files[selected] == nil)
          Button(saving ? "Saving…" : "Save", systemImage: "arrow.down.to.line") {
            Task { await savePhoto() }
          }.disabled(files[selected]?.image == nil || saving)
        } label: {
          Image(systemName: "ellipsis").font(.system(size: 17)).frame(width: 44, height: 44).nativeGlass(darkTint: 0.06)
        }.accessibilityLabel("Photo options").accessibilityIdentifier("photo-options")
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
            } else { ProgressView().tint(.white) }
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
                      if let image = files[item.id]?.image { Image(uiImage: image).resizable().scaledToFill() }
                      if item.id != selected { Color.black.opacity(0.48) }
                    }.frame(width: 48, height: 48).clipShape(RoundedRectangle(cornerRadius: 9))
                      .overlay { if item.id == selected { RoundedRectangle(cornerRadius: 9).stroke(.white, lineWidth: 2) } }
                  }.buttonStyle(.plain).padding(.vertical, 2).id(item.id)
                    .accessibilityLabel("Photo \((items.firstIndex { $0.id == item.id } ?? 0) + 1)")
                    .accessibilityIdentifier("photo-thumbnail-" + item.asset.id)
                    .accessibilityAddTraits(item.id == selected ? .isSelected : [])
                    .task { await load(item) }
                }
              }.padding(.horizontal, max(16, (geometry.size.width - 48) / 2))
            }.scrollIndicators(.hidden).frame(height: 52)
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
    guard files[item.id] == nil, loading.insert(item.id).inserted else { return }
    defer { loading.remove(item.id) }
    do {
      let file = try await LoadedAttachment.fetch(item.asset, store: store, maximumPixels: 2048)
      guard file.image != nil else { throw APIError("This image could not be loaded.") }
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
  func updateUIView(_ view: PhotoScrollView, context: Context) { view.setNeedsLayout() }
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
        ForEach(store.channels.filter { !store.isHidden($0) }) { channel in
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
