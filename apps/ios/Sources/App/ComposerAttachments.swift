import AVFoundation
import Photos
import SwiftUI

/// A staged photo or video in the draft.
struct ComposerPhoto: Identifiable {
  let url: URL
  let name: String
  var mimeType = "image/jpeg"
  var id: URL { url }
  var isVideo: Bool { mimeType.hasPrefix("video/") }
  /// Staged files are stored under an identifier, without an extension.
  var asset: AVURLAsset { AVURLAsset(url: url, options: [AVURLAssetOverrideMIMETypeKey: mimeType]) }
}

struct PendingAttachment: Identifiable {
  let id = UUID()
  let video: Bool
  var progress = 0.0
}

private enum ComposerMedia {
  static let side: CGFloat = 120
  static let radius: CGFloat = 16
  static func duration(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds >= 0 else { return "0:00" }
    let total = Int(seconds.rounded())
    return total >= 3600
      ? String(format: "%d:%02d:%02d", total / 3600, total / 60 % 60, total % 60)
      : String(format: "%d:%02d", total / 60, total % 60)
  }
}

/// A draft photo or video in the composer: tap to view it, × to remove it.
struct ComposerThumbnail: View {
  let media: ComposerPhoto
  let open: () -> Void
  let remove: () -> Void
  @State private var image: UIImage?
  @State private var duration: Double?
  var body: some View {
    Button(action: open) {
      ZStack(alignment: .bottomLeading) {
        NativePalette.surface
        if let image {
          Image(uiImage: image).resizable().scaledToFill()
            .frame(width: ComposerMedia.side, height: ComposerMedia.side).clipped()
            .transition(.opacity)
        }
        if let duration {
          Text(ComposerMedia.duration(duration))
            .font(.system(size: 13, weight: .semibold)).monospacedDigit().foregroundStyle(.white)
            .padding(.horizontal, 6).padding(.vertical, 3)
            .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .padding(7)
        }
      }
      .frame(width: ComposerMedia.side, height: ComposerMedia.side)
      .clipShape(RoundedRectangle(cornerRadius: ComposerMedia.radius, style: .continuous))
      .contentShape(RoundedRectangle(cornerRadius: ComposerMedia.radius, style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel((media.isVideo ? "Play " : "View ") + media.name)
    .accessibilityIdentifier("composer-photo")
    .overlay(alignment: .topTrailing) {
      Button(action: remove) {
        Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
          .frame(width: 22, height: 22)
          .background(Color.black.opacity(0.62), in: Circle())
          .frame(width: 44, height: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .padding(-3)
      .accessibilityLabel("Remove " + media.name)
    }
    .task(id: media.url) {
      let decoded: UIImage?
      if media.isVideo {
        let asset = media.asset
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: ComposerMedia.side * 3, height: ComposerMedia.side * 3)
        decoded = (try? await generator.image(at: .zero).image).map { UIImage(cgImage: $0) }
        duration = (try? await asset.load(.duration)).map(\.seconds)
      } else {
        decoded = (try? await AttachmentImageFile.decode(media.url, maximumPixels: Int(ComposerMedia.side * 3)))
          .flatMap { $0 }.map { UIImage(cgImage: $0) }
      }
      withAnimation(.easeOut(duration: 0.2)) { image = decoded }
    }
  }
}

/// A picked item still copying out of the library, with its progress.
struct ComposerPendingThumbnail: View {
  let progress: Double
  var body: some View {
    ZStack {
      NativePalette.surface
      ProgressRing(progress: progress).frame(width: 30, height: 30)
    }
    .frame(width: ComposerMedia.side, height: ComposerMedia.side)
    .clipShape(RoundedRectangle(cornerRadius: ComposerMedia.radius, style: .continuous))
    .accessibilityElement()
    .accessibilityLabel("Preparing attachment")
    .accessibilityValue("\(Int(progress * 100)) percent")
    .accessibilityIdentifier("composer-pending")
  }
}

private struct ProgressRing: View {
  let progress: Double
  @State private var spin = false
  var body: some View {
    ZStack {
      Circle().stroke(NativePalette.text.opacity(0.18), lineWidth: 3)
      Circle()
        .trim(from: 0, to: max(0.06, min(1, progress)))
        .stroke(NativePalette.text, style: StrokeStyle(lineWidth: 3, lineCap: .round))
        .rotationEffect(.degrees(-90))
        .animation(.easeOut(duration: 0.2), value: progress)
    }
    // Waiting for the first bytes, the short arc turns so the ring still reads as busy.
    .rotationEffect(.degrees(progress < 0.02 && spin ? 360 : 0))
    .animation(progress < 0.02 ? .linear(duration: 0.9).repeatForever(autoreverses: false) : .default,
      value: spin)
    .onAppear { spin = true }
  }
}

/// The draft's photos and videos full screen, swiped through sideways and
/// opening on the one that was tapped.
struct ComposerGallery: Identifiable {
  let items: [ComposerPhoto]
  let start: URL
  var id: URL { start }
}

struct ComposerGalleryView: View {
  let gallery: ComposerGallery
  var closing: () -> Void = {}
  @State private var selection: URL
  init(gallery: ComposerGallery, closing: @escaping () -> Void = {}) {
    self.gallery = gallery
    self.closing = closing
    _selection = State(initialValue: gallery.start)
  }
  @Environment(\.dismiss) private var dismiss
  private var current: ComposerPhoto? { gallery.items.first { $0.url == selection } }
  var body: some View {
    // Pages keep the safe area, so their controls stay clear of the Dynamic
    // Island and of side regions such as the folded Duo's status strip.
    TabView(selection: $selection) {
      ForEach(gallery.items) { item in
        Group {
          if item.isVideo {
            ComposerVideoViewer(video: item, active: selection == item.url, showsClose: false, closing: closing)
          } else {
            ComposerPhotoViewer(photo: item, showsClose: false, closing: closing)
          }
        }.tag(item.url)
      }
    }
    .tabViewStyle(.page(indexDisplayMode: .never))
    .accessibilityIdentifier("composer-gallery")
    .background(Color.black.ignoresSafeArea())
    // One Close for every page: leading over a video, whose trailing corner holds
    // Save and Share, and trailing over a photo.
    .overlay(alignment: current?.isVideo == true ? .topLeading : .topTrailing) {
      ViewerCircle(symbol: "xmark", label: "Close") {
        closing()
        dismiss()
      }
      .padding(.horizontal, 16).padding(.top, 8)
      .accessibilityIdentifier("composer-photo-close")
    }
    // White status bar over the black viewer, in either appearance.
    .preferredColorScheme(.dark)
  }
}

/// A draft photo on black, with nothing to do but look and close.
struct ComposerPhotoViewer: View {
  @Environment(\.dismiss) private var dismiss
  let photo: ComposerPhoto
  /// False inside the gallery, which has one Close for every page.
  var showsClose = true
  /// Runs as the viewer starts to close, so the keyboard rises while it slides away.
  var closing: () -> Void = {}
  @State private var image: UIImage?
  @State private var zoom: CGFloat = 1
  @GestureState private var pinch: CGFloat = 1
  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      if let image {
        Image(uiImage: image).resizable().scaledToFit()
          .scaleEffect(zoom * pinch)
          .gesture(MagnifyGesture()
            .updating($pinch) { value, state, _ in state = value.magnification }
            .onEnded { value in
              withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
                zoom = min(4, max(1, zoom * value.magnification))
              }
            })
          .onTapGesture(count: 2) {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { zoom = zoom > 1 ? 1 : 2.5 }
          }
          .transition(.opacity)
          .accessibilityLabel(photo.name)
      } else {
        LoadingOrb(theme: .dark, label: "Loading photo")
      }
    }
    .overlay(alignment: .topTrailing) {
      if showsClose {
        ViewerCircle(symbol: "xmark", label: "Close") {
          closing()
          dismiss()
        }
        .padding(.trailing, 16).padding(.top, 8)
        .accessibilityIdentifier("composer-photo-close")
      }
    }
    .environment(\.colorScheme, .dark)
    .task {
      let decoded = try? await AttachmentImageFile.decode(photo.url, maximumPixels: 4096)
      withAnimation(.easeOut(duration: 0.18)) { image = decoded.flatMap { $0 }.map { UIImage(cgImage: $0) } }
    }
  }
}

private struct ViewerCircle: View {
  let symbol: String
  let label: String
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
        .contentTransition(.symbolEffect(.replace))
        .frame(width: 48, height: 48)
        .modifier(NativeGlass(radius: 24, darkTint: 0.1))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
}

@MainActor @Observable private final class VideoPlayback {
  let player: AVPlayer
  var time = 0.0
  var duration = 0.0
  var playing = false
  private var observer: Any?
  private var ended: NSObjectProtocol?
  init(asset: AVURLAsset) {
    player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
    Task { [weak self] in
      if let seconds = try? await asset.load(.duration).seconds, seconds.isFinite { self?.duration = seconds }
    }
    observer = player.addPeriodicTimeObserver(
      forInterval: CMTime(value: 1, timescale: 30), queue: .main
    ) { [weak self] time in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.time = time.seconds
        if let seconds = self.player.currentItem?.duration.seconds, seconds.isFinite { self.duration = seconds }
      }
    }
    ended = NotificationCenter.default.addObserver(
      forName: AVPlayerItem.didPlayToEndTimeNotification, object: player.currentItem, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.playing = false
        self?.player.seek(to: .zero)
      }
    }
  }
  func pause() {
    player.pause()
    playing = false
  }
  func toggle() {
    playing ? player.pause() : player.play()
    playing.toggle()
  }
  func seek(_ seconds: Double) {
    time = seconds
    player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
  }
  func stop() {
    player.pause()
    if let observer { player.removeTimeObserver(observer) }
    if let ended { NotificationCenter.default.removeObserver(ended) }
    observer = nil
    ended = nil
  }
}

private struct PlayerSurface: UIViewRepresentable {
  let player: AVPlayer
  func makeUIView(context: Context) -> PlayerView {
    let view = PlayerView()
    view.playerLayer.player = player
    view.playerLayer.videoGravity = .resizeAspect
    return view
  }
  func updateUIView(_ view: PlayerView, context: Context) {}
  final class PlayerView: UIView {
    override static var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
  }
}

/// A draft video on black: play, scrub, save to Photos or share.
struct ComposerVideoViewer: View {
  @Environment(\.dismiss) private var dismiss
  let video: ComposerPhoto
  /// The gallery's current page; a video paged away from pauses.
  var active = true
  /// False inside the gallery, which has one Close for every page.
  var showsClose = true
  var closing: () -> Void = {}
  @State private var playback: VideoPlayback
  @State private var saved = false
  @State private var sharing: URL?
  @State private var failure: String?
  init(video: ComposerPhoto, active: Bool = true, showsClose: Bool = true, closing: @escaping () -> Void = {}) {
    self.video = video
    self.active = active
    self.showsClose = showsClose
    self.closing = closing
    _playback = State(initialValue: VideoPlayback(asset: video.asset))
  }
  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      PlayerSurface(player: playback.player).ignoresSafeArea()
        .contentShape(Rectangle())
        .onTapGesture { playback.toggle() }
        .accessibilityLabel(video.name)
      if !playback.playing {
        Button { playback.toggle() } label: {
          Image(systemName: "play.fill").font(.system(size: 30)).foregroundStyle(.white)
            .offset(x: 2)
            .frame(width: 76, height: 76)
            .modifier(NativeGlass(radius: 38, darkTint: 0.1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Play")
        .accessibilityIdentifier("composer-video-play")
        .transition(.opacity.combined(with: .scale(scale: 0.85)))
      }
    }
    .animation(.easeOut(duration: 0.18), value: playback.playing)
    .overlay(alignment: .top) {
      HStack(spacing: 10) {
        if showsClose {
          ViewerCircle(symbol: "xmark", label: "Close") {
            playback.stop()
            closing()
            dismiss()
          }.accessibilityIdentifier("composer-photo-close")
        }
        Spacer()
        ViewerCircle(symbol: saved ? "checkmark" : "arrow.down.to.line", label: saved ? "Saved" : "Save to Photos") {
          Task { await save() }
        }.disabled(saved)
        Button {
          sharing = try? namedCopy()
        } label: {
          Text("Share").font(.system(size: 17, weight: .semibold)).foregroundStyle(.black)
            .padding(.horizontal, 20).frame(height: 48)
            .background(.white, in: Capsule())
        }.buttonStyle(.plain)
      }
      .padding(.horizontal, 16).padding(.top, 8)
    }
    .overlay(alignment: .bottom) {
      HStack(spacing: 12) {
        Text(ComposerMedia.duration(playback.time)).frame(minWidth: 40, alignment: .leading)
        Scrubber(playback: playback)
        Text(ComposerMedia.duration(playback.duration)).frame(minWidth: 40, alignment: .trailing)
      }
      .font(.system(size: 15, weight: .medium)).monospacedDigit().foregroundStyle(.white)
      .padding(.horizontal, 20).frame(height: 52)
      .modifier(NativeGlass(radius: 26, darkTint: 0.1))
      .padding(.horizontal, 16).padding(.bottom, 8)
    }
    .sheet(item: Binding(get: { sharing.map(SharedFile.init) }, set: { sharing = $0?.url })) { file in
      NativeFileShare(url: file.url) { failure = UserFacingError.message($0) }
    }
    .alert("Couldn’t save video", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
      Button("OK") { failure = nil }
    } message: { Text(failure ?? "") }
    .environment(\.colorScheme, .dark)
    .onChange(of: active) { _, active in if !active { playback.pause() } }
    .onDisappear { playback.pause() }
  }
  private struct SharedFile: Identifiable {
    let url: URL
    var id: URL { url }
  }
  /// Photos and the share sheet need the file's real name and extension.
  private func namedCopy() throws -> URL {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("composer-share", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let target = folder.appendingPathComponent(video.name)
    try? FileManager.default.removeItem(at: target)
    try FileManager.default.copyItem(at: video.url, to: target)
    return target
  }
  private func save() async {
    do {
      guard await PHPhotoLibrary.requestAuthorization(for: .addOnly) == .authorized else {
        throw APIError("Allow OpenTeam to add to Photos in Settings to save this video.")
      }
      let url = try namedCopy()
      try await PHPhotoLibrary.shared().performChanges {
        _ = PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
      }
      NativeHaptics.play(.success, source: "attachment.save")
      withAnimation { saved = true }
    } catch {
      NativeHaptics.failure(error, source: "attachment.save")
      failure = UserFacingError.message(error)
    }
  }
}

/// A thin line, filled to the playhead; drag anywhere along it to scrub.
private struct Scrubber: View {
  let playback: VideoPlayback
  @State private var resume = false
  var body: some View {
    GeometryReader { geometry in
      let fraction = playback.duration > 0 ? min(1, max(0, playback.time / playback.duration)) : 0
      ZStack(alignment: .leading) {
        Capsule().fill(.white.opacity(0.28)).frame(height: 4)
        Capsule().fill(.white).frame(width: geometry.size.width * fraction, height: 4)
      }
      .frame(maxHeight: .infinity)
      .contentShape(Rectangle())
      .gesture(DragGesture(minimumDistance: 0)
        .onChanged { value in
          if !resume && playback.playing { resume = true; playback.player.pause() }
          let x = min(max(0, value.location.x / max(1, geometry.size.width)), 1)
          playback.seek(x * playback.duration)
        }
        .onEnded { _ in
          if resume { playback.player.play() }
          resume = false
        })
    }
    .frame(height: 44)
    .accessibilityElement()
    .accessibilityLabel("Position")
    .accessibilityValue(ComposerMedia.duration(playback.time))
    .accessibilityAdjustableAction { direction in
      let step = direction == .increment ? 5.0 : -5.0
      playback.seek(min(max(0, playback.time + step), playback.duration))
    }
  }
}
