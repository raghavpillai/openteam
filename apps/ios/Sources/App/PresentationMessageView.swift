import SwiftUI
import MapKit
import ImageIO

private func presentationURL(_ value: String?) -> URL? {
  guard let value, let url = URL(string: value), url.scheme == "https", url.user == nil, url.password == nil else { return nil }
  return url
}
/// The app accent is monochrome; places use the map's route blue.
private let placeAccent = Color.blue
// Formatting matches the desktop client: Apple-style durations, ratings
// rounded half away from zero, pluralised and grouped review counts.
private func travelTime(_ seconds: Double) -> String {
  PresentationRoute.travelTime(seconds)
}
private func formatRating(_ rating: Double) -> String {
  rating.formatted(.number.precision(.fractionLength(1)).rounded(rule: .toNearestOrAwayFromZero))
}
private func ratingsLabel(_ count: Int?) -> String {
  guard let count, count > 0 else { return "Rating" }
  return "\(count.formatted()) \(count == 1 ? "Rating" : "Ratings")"
}
/// Thins a route to what a map can show (Douglas–Peucker in map points), so
/// a 5,000-point drive draws as smoothly as a short walk.
private func displayRoute(_ coordinates: [[Double]], maxPoints: Int = 400) -> [CLLocationCoordinate2D] {
  let points = coordinates.map { CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) }
  guard points.count > maxPoints else { return points }
  let mapPoints = points.map(MKMapPoint.init)
  let xs = mapPoints.map(\.x), ys = mapPoints.map(\.y)
  let diagonal = hypot((xs.max() ?? 0) - (xs.min() ?? 0), (ys.max() ?? 0) - (ys.min() ?? 0))
  var keep = [Bool](repeating: false, count: points.count)
  keep[0] = true; keep[points.count - 1] = true
  // A tolerance of ~1/1500 of the route's extent is under a point at any
  // zoom that shows the whole route.
  let tolerance = diagonal / 1500
  var stack = [(0, points.count - 1)]
  while let (first, last) = stack.popLast() {
    guard last > first + 1 else { continue }
    let a = mapPoints[first], b = mapPoints[last]
    let dx = b.x - a.x, dy = b.y - a.y, length = max(hypot(dx, dy), 1e-9)
    var farthest = first, distance = 0.0
    for i in (first + 1)..<last {
      let d = abs(dy * (mapPoints[i].x - a.x) - dx * (mapPoints[i].y - a.y)) / length
      if d > distance { distance = d; farthest = i }
    }
    if distance > tolerance { keep[farthest] = true; stack.append((first, farthest)); stack.append((farthest, last)) }
  }
  return points.indices.filter { keep[$0] }.map { points[$0] }
}
/// Places sharing a spot (same building) are fanned out side by side instead
/// of drawing exactly on top of each other.
private func pinFanOffsets(_ places: [PresentationPlace]) -> [String: CGFloat] {
  var groups: [String: [String]] = [:]
  for place in places { groups[String(format: "%.4f,%.4f", place.latitude, place.longitude), default: []].append(place.id) }
  var offsets: [String: CGFloat] = [:]
  for ids in groups.values where ids.count > 1 {
    for (i, id) in ids.enumerated() { offsets[id] = (CGFloat(i) - CGFloat(ids.count - 1) / 2) * 40 }
  }
  return offsets
}
/// "Empire State Building, Start here, rated 4.5 stars, Tripadvisor, Observation deck, Open".
private func placeSpokenLabel(_ place: PresentationPlace, _ label: String?) -> String {
  [place.name, label, place.rating.map { "rated \(formatRating($0)) stars" }, place.provider, place.category,
   place.isOpen.map { $0 ? "Open" : "Closed" }].compactMap { $0 }.joined(separator: ", ")
}
/// Any pictographic emoji (including text-default ones like 🏙️), as on desktop.
private func placeGlyph(_ icon: String?) -> String? {
  guard let icon, icon.unicodeScalars.contains(where: { $0.properties.isEmoji && $0.value > 0x203B }) else { return nil }
  return icon
}
private func modeName(_ route: PresentationRoute) -> String { route.mode == "walking" ? "Walk" : route.mode == "cycling" ? "Cycle" : "Drive" }
private func stopLabel(_ route: PresentationRoute?, _ index: Int) -> String? {
  guard let route else { return nil }
  if index == 0 { return "Start here" }
  return index - 1 < route.legs.count ? "\(modeName(route)) ~\(travelTime(route.legs[index - 1].durationSeconds))" : "Stop \(index + 1)"
}

/// One spring family, snappy first and gooey second (same curves as desktop's
/// motion.ts): the morph keeps a small jelly overshoot but lands in ~0.4 s,
/// closing is near-critical, and secondary content follows quickly.
private enum PlaceMotion {
  /// Card → preview: keeps a ~5% jelly overshoot, 95% there in ~145 ms.
  static func morph(_ reduce: Bool) -> Animation { reduce ? .easeInOut(duration: 0.16) : .spring(response: 0.32, dampingFraction: 0.68) }
  /// Closing is direct feedback: ~150 ms to 95%, no overshoot.
  static func settle(_ reduce: Bool) -> Animation { reduce ? .easeInOut(duration: 0.16) : .spring(response: 0.22, dampingFraction: 0.94) }
  static func soft(_ reduce: Bool) -> Animation { reduce ? .easeInOut(duration: 0.16) : .spring(response: 0.26, dampingFraction: 0.86) }
  /// Switching places: an opacity-only swap, no movement.
  static let swap = Animation.easeOut(duration: 0.12)
  static let camera = Animation.spring(response: 0.34, dampingFraction: 0.92)
  static func press(_ pressed: Bool) -> Animation { pressed ? .easeOut(duration: 0.08) : .spring(response: 0.22, dampingFraction: 0.7) }
}
/// Images shared by cards, pins and panels, kept in memory so a view that a
/// morph re-inserts never flashes its placeholder while reloading.
@MainActor enum PlaceImages {
  static var generation: UUID?
  static var requests: [UUID: Task<Data, Error>] = [:]
  static let values: NSCache<NSString, UIImage> = {
    let cache = NSCache<NSString, UIImage>()
    cache.totalCostLimit = 24 * 1024 * 1024
    cache.countLimit = 64
    return cache
  }()
  static func select(_ next: UUID?) {
    if generation != next {
      for task in requests.values { task.cancel() }
      requests.removeAll()
      values.removeAllObjects(); generation = next
    }
  }
  static func data(_ api: API, source: String) async throws -> Data {
    let id = UUID()
    let task = Task { try await api.presentationImage(source) }
    requests[id] = task
    defer { requests.removeValue(forKey: id) }
    return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
  }
}
private struct CachedImage<Placeholder: View>: View {
  @Environment(AppStore.self) private var store
  let url: URL?
  var onLoad: ((Bool) -> Void)? = nil
  @ViewBuilder var placeholder: () -> Placeholder
  @State private var image: UIImage?
  @State private var loadedKey: String?
  private var key: String? {
    guard let url, let api = store.api else { return nil }
    return api.resourceGeneration.uuidString + ":" + url.absoluteString
  }
  var body: some View {
    Group {
      if loadedKey == key, let image { Image(uiImage: image).resizable().scaledToFill() } else { placeholder() }
    }
    .onChange(of: loadedKey == key && image != nil, initial: true) { _, loaded in onLoad?(loaded) }
    .task(id: key) {
      image = nil; loadedKey = nil
      PlaceImages.select(store.api?.resourceGeneration)
      guard let key, let url, let api = store.api else { return }
      if let hit = PlaceImages.values.object(forKey: key as NSString) { image = hit; loadedKey = key; return }
      guard let data = try? await PlaceImages.data(api, source: url.absoluteString) else { return }
      let decoded = await Task.detached(priority: .utility) { () -> CGImage? in
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: 960,
          kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary)
      }.value
      guard !Task.isCancelled, store.api?.resourceGeneration == api.resourceGeneration, let decoded else { return }
      let loaded = UIImage(cgImage: decoded)
      PlaceImages.values.setObject(loaded, forKey: key as NSString, cost: decoded.bytesPerRow * decoded.height)
      image = loaded; loadedKey = key
    }
  }
}

extension View {
  /// Matched geometry, except under Reduce Motion, where views cross-fade in place.
  @ViewBuilder fileprivate func placeMatch(_ id: String, in namespace: Namespace.ID, enabled: Bool) -> some View {
    if enabled { matchedGeometryEffect(id: id, in: namespace) } else { self }
  }
  /// Soft scroll edges (iOS 26) so content fades under headers instead of being cut.
  @ViewBuilder fileprivate func softScrollEdges() -> some View {
    if #available(iOS 26, *) { scrollEdgeEffectStyle(.soft, for: .all) } else { self }
  }
}
/// Directions open in Apple Maps in the route's own mode (walking, driving or cycling).
private func directionsURL(_ place: PresentationPlace, _ mode: String?) -> URL? {
  var components = URLComponents(string: "https://maps.apple.com/directions")
  components?.queryItems = [URLQueryItem(name: "destination", value: String(format: "%.6f,%.6f", place.latitude, place.longitude))]
    + (mode.map { [URLQueryItem(name: "mode", value: $0)] } ?? [])
  return components?.url
}

/// Liquid Glass where available; a layered material with a specular rim before iOS 26.
private struct PlaceGlass: View {
  var radius: CGFloat
  var interactive = false
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
    if #available(iOS 26, *) {
      let glass = Glass.regular.tint(scheme == .dark ? Color.black.opacity(0.12) : Color.white.opacity(0.08))
      Color.clear.glassEffect(interactive ? glass.interactive() : glass, in: shape)
    } else {
      shape.fill(.ultraThinMaterial)
        .overlay(shape.fill(LinearGradient(colors: [.white.opacity(scheme == .dark ? 0.08 : 0.4), .clear], startPoint: .top, endPoint: .center)))
        .overlay(shape.strokeBorder(LinearGradient(colors: [.white.opacity(scheme == .dark ? 0.28 : 0.9), .white.opacity(scheme == .dark ? 0.04 : 0.25)], startPoint: .top, endPoint: .bottom), lineWidth: 0.75))
        .shadow(color: .black.opacity(scheme == .dark ? 0.4 : 0.14), radius: 16, y: 6)
    }
  }
}
private struct GlassCircleButtonStyle: ButtonStyle {
  var size: CGFloat = 40
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.foregroundStyle(NativePalette.text).frame(width: size, height: size)
      .background { PlaceGlass(radius: size / 2) }
      .scaleEffect(configuration.isPressed ? 0.88 : 1)
      .animation(PlaceMotion.press(configuration.isPressed), value: configuration.isPressed)
      .contentShape(Circle())
      .modifier(MinimumHitTarget(size: size))
  }
}
extension View {
  /// Liquid Glass in `shape` for every Apple-styled surface: tinted for
  /// accents, interactive for anything tappable so touches get glass's own
  /// press response. Before iOS 26, a material with the same tint.
  @ViewBuilder func liquidGlass<S: Shape>(_ shape: S, tint: Color? = nil, interactive: Bool = false) -> some View {
    if #available(iOS 26, *) {
      let glass = tint.map { Glass.regular.tint($0) } ?? Glass.regular
      glassEffect(interactive ? glass.interactive() : glass, in: shape)
    } else {
      background { shape.fill(.ultraThinMaterial).overlay(shape.fill(tint ?? .clear)) }
    }
  }
}
/// Groups neighbouring glass so it renders and morphs as one surface.
private struct GlassGroup<Content: View>: View {
  var spacing: CGFloat = 4
  @ViewBuilder var content: Content
  var body: some View {
    if #available(iOS 26, *) { GlassEffectContainer(spacing: spacing) { content } } else { content }
  }
}
/// A squash on press that springs back with an overshoot. With `haptic`, the
/// touch-down lands with a soft tap, so the control feels like it has mass.
private struct SquishButtonStyle: ButtonStyle {
  var scale: CGFloat = 0.965
  var haptic = false
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.scaleEffect(x: configuration.isPressed ? scale : 1, y: configuration.isPressed ? scale - 0.015 : 1)
      .animation(PlaceMotion.press(configuration.isPressed), value: configuration.isPressed)
      .onChange(of: configuration.isPressed) { _, pressed in
        if pressed && haptic { NativeHaptics.play(.soft, intensity: 0.45, source: "place.press") }
      }
  }
}

/// Map state that must outlive the chat cell: the message list rebuilds cells
/// (for example when the text size changes), which would otherwise close an
/// open preview and drop the selection.
@MainActor private final class PlaceMapMemory {
  static let shared = PlaceMapMemory()
  struct State { var selected: String?; var preview: String? }
  var states: [String: State] = [:]
  /// Opening a preview in one map closes it in every other map in the chat.
  static let previewOpened = Notification.Name("PlaceMapPreviewOpened")
}
/// Tap targets of at least 44pt around smaller glass controls, without
/// changing their layout.
private struct MinimumHitTarget: ViewModifier {
  var size: CGFloat
  func body(content: Content) -> some View {
    let pad = max(0, (44 - size) / 2)
    content.padding(pad).contentShape(Rectangle()).padding(-pad)
  }
}
/// An outgoing panel stops taking touches as soon as it starts leaving.
private struct HitTesting: ViewModifier {
  var enabled: Bool
  func body(content: Content) -> some View { content.allowsHitTesting(enabled) }
}

struct PresentationMessageView: View {
  let presentation: PresentationPayload
  var stateKey = ""
  var body: some View {
    VStack(alignment: .leading, spacing: 24) {
      ForEach(Array(presentation.blocks.enumerated()), id: \.offset) { index, block in
        switch block {
        case .markdown(let text):
          if RichMarkdownView.required(text) { RichMarkdownView(source: text).frame(maxWidth: .infinity) }
          else { MarkdownText(source: text).font(.body).fixedSize(horizontal: false, vertical: true) }
        case .map(let map): PresentationMapView(block: map, allPlaces: presentation.places, memoryKey: "\(stateKey)#\(index)")
        case .media(let media): PresentationMediaView(block: media, places: presentation.places)
        }
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}
private struct PlaceThumbnail: View {
  let source: String?
  let name: String
  var size: CGFloat = 64
  var radius: CGFloat?
  var icon: String? = nil
  var body: some View {
    CachedImage(url: presentationURL(source)) {
      ZStack {
        placeAccent.opacity(0.12)
        if let glyph = placeGlyph(icon) { Text(glyph).font(.system(size: size * 0.42)) }
        else { Image(systemName: "mappin.and.ellipse").font(.system(size: size * 0.3)).foregroundStyle(placeAccent.opacity(0.7)) }
      }
    }.frame(width: size, height: size)
      .clipShape(RoundedRectangle(cornerRadius: radius ?? (size > 90 ? 18 : size * 0.21), style: .continuous))
      .accessibilityHidden(true)
  }
}
private struct PlaceMeta: View {
  let place: PresentationPlace
  private var rating: some View {
    HStack(spacing: 2) {
      Image(systemName: "star.fill").foregroundStyle(Color.orange)
      Text(place.rating.map(formatRating) ?? "").fontWeight(.semibold)
    }.fixedSize()
  }
  private var separator: some View { Text("·").foregroundStyle(.secondary) }
  var body: some View {
    // Drop pieces from the end rather than truncate to a dangling "· …".
    ViewThatFits(in: .horizontal) {
      line(provider: true, category: true)
      line(provider: false, category: true)
      line(provider: true, category: false)
      line(provider: false, category: false)
    }.font(.caption).foregroundStyle(NativePalette.text.opacity(0.8))
  }
  @ViewBuilder private func line(provider showProvider: Bool, category showCategory: Bool) -> some View {
    HStack(spacing: 4) {
      if place.rating != nil { rating }
      // The provider credits a rating; without one it is only noise (the source link remains).
      let credit = showProvider && place.rating != nil ? place.provider : nil
      if let credit { Text(credit).foregroundStyle(.secondary).fixedSize() }
      if showCategory, let category = place.category {
        if place.rating != nil { separator }
        Text(category).fixedSize()
      }
    }.lineLimit(1)
  }
}
private struct PlaceDetails: View {
  let place: PresentationPlace
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(place.name).font(.subheadline.weight(.semibold)).foregroundStyle(NativePalette.text).lineLimit(2)
      PlaceMeta(place: place)
      if let open = place.isOpen { Text(open ? "Open" : "Closed").font(.caption.weight(.medium)).foregroundStyle(open ? Color.green : Color.red) }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct PresentationMapView: View {
  let block: PresentationMap
  let allPlaces: [PresentationPlace]
  var memoryKey = ""
  @State private var selected: String?
  @State private var fullScreen = false
  @State private var preview: PresentationPlace?
  /// Whether the open preview grew out of its card (false when opened from a
  /// pin whose card is off-screen: it then rises from the bottom instead).
  @State private var morphFromCard = true
  /// The card the carousel has snapped to; each new snap ticks a haptic.
  @State private var centered: String?
  /// The open preview's measured height, which frames the selected pin above it.
  @State private var panelHeight: CGFloat = PlaceInlineDetail.inlineHeight
  /// Set while the carousel scrolls itself (selection from a pin or fullscreen),
  /// so those scrolls never tick or re-select like a swipe.
  @State private var programmaticScroll = false
  /// The card a preview is closing back into; its text fades in as it lands.
  @State private var returning: String?
  @Environment(\.openURL) private var openURL
  @Namespace private var morph
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private var places: [PresentationPlace] { block.placeIds.compactMap { id in allPlaces.first { $0.id == id } } }
  private var previewIndex: Int? { preview.flatMap { p in places.firstIndex { $0.id == p.id } } }
  private var hasCards: Bool { block.carousel != "hidden" }
  init(block: PresentationMap, allPlaces: [PresentationPlace], memoryKey: String = "") {
    self.block = block; self.allPlaces = allPlaces; self.memoryKey = memoryKey
    let saved = PlaceMapMemory.shared.states[memoryKey]
    _selected = State(initialValue: saved?.selected)
    _centered = State(initialValue: saved?.selected)
    _preview = State(initialValue: saved?.preview.flatMap { id in allPlaces.first { $0.id == id } })
  }
  private func remember() {
    guard !memoryKey.isEmpty else { return }
    PlaceMapMemory.shared.states[memoryKey] = .init(selected: selected, preview: preview?.id)
  }

  private func open(_ place: PresentationPlace, fromPin: Bool = false) {
    guard preview?.id != place.id else { return }
    if preview == nil {
      // A pin whose card isn't the one in view has nothing on screen to grow
      // out of; bring its card into place without animation and rise instead.
      morphFromCard = !(fromPin && centered != place.id)
      if !morphFromCard {
        programmaticScroll = true
        centered = place.id
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { programmaticScroll = false }
      }
    }
    selected = place.id
    if preview == nil {
      // A first open is a soft thud as the card grows out of its slot.
      NativeHaptics.play(.soft, intensity: 0.85, source: "place.open")
      withAnimation(PlaceMotion.morph(reduceMotion)) { preview = place }
    } else {
      // Switching places keeps the panel where it is; only its content
      // changes, so the shared geometry moves without a morph.
      NativeHaptics.play(.selection, source: "place.selection")
      var transaction = Transaction()
      transaction.disablesAnimations = true
      withTransaction(transaction) { preview = place }
    }
  }
  private func close() {
    NativeHaptics.play(.light, intensity: 0.55, source: "place.close")
    returning = preview?.id
    withAnimation(PlaceMotion.settle(reduceMotion)) { preview = nil }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { returning = nil }
  }
  private func expand() {
    // Drop the preview without a morph, then present on the next pass so the
    // zoom snapshots a settled map rather than mid-flight pieces.
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) { preview = nil }
    NativeHaptics.play(.medium, intensity: 0.7, source: "place.expand")
    DispatchQueue.main.async { fullScreen = true }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if let title = block.title { Text(title).font(.headline) }
      ZStack(alignment: .bottom) {
        // The safe area under the cards stays constant (MapKit applies safe-area
        // changes without animation, which made the camera cut and could leave
        // Legal stuck under the cards). The preview is framed by the camera alone.
        NativePlaceMap(places: places, route: block.route, selected: $selected, hasCards: hasCards,
                       // The expand button covers the top-right corner; keep pins clear of it.
                       obscuredBottom: hasCards ? 132 : 0, obscuredTop: 56,
                       panelTop: preview != nil ? 400 - panelHeight - 12 : nil,
                       onPin: { place in open(place, fromPin: true) })
        if hasCards { carousel }
      }
      .frame(maxWidth: .infinity).frame(height: 400)
      // The map's own menu, instead of the whole message's.
      .contextMenu {
        Button("Open Map", systemImage: "arrow.up.left.and.arrow.down.right", action: expand)
        if let place = preview ?? places.first(where: { $0.id == selected }) ?? places.first, let url = directionsURL(place, block.route?.mode) {
          Button("Directions to \(place.name)", systemImage: "arrow.triangle.turn.up.right.circle") { openURL(url) }
        }
      }
      // Overlays never affect layout, so the preview can't widen the chat bubble.
      .overlay {
        if preview != nil {
          LinearGradient(colors: [.black.opacity(0.16), .clear], startPoint: .bottom, endPoint: .center)
            .allowsHitTesting(false).transition(.opacity)
        }
      }
      .overlay(alignment: .bottom) {
        if let preview {
          PlaceInlineDetail(place: preview, label: previewIndex.flatMap { stopLabel(block.route, $0) }, mode: block.route?.mode,
                            namespace: morph, morphs: morphFromCard, onHeight: { panelHeight = $0 }, onClose: close)
            .padding(12)
            // Only the glass and photo travel back into the card; the panel's
            // text is gone at once so nothing is drawn twice, and it stops
            // taking touches the moment it starts leaving.
            .transition(.asymmetric(
              insertion: morphFromCard || reduceMotion ? .identity : .scale(scale: 0.94, anchor: .bottom).combined(with: .opacity),
              removal: .opacity.animation(.linear(duration: 0.06))
                .combined(with: .modifier(active: HitTesting(enabled: false), identity: HitTesting(enabled: true)))))
        }
      }
      .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
      .overlay(alignment: .topTrailing) {
        Button(action: expand) { Image(systemName: "arrow.up.left.and.arrow.down.right").font(.system(size: 16, weight: .semibold)) }
          .buttonStyle(GlassCircleButtonStyle()).padding(12)
          .accessibilityLabel("Open map full screen").accessibilityHint("View the map and all itinerary stops").accessibilityIdentifier("expand-place-map")
      }
      .matchedTransitionSource(id: "place-map", in: morph) { $0.clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous)) }
    }
    .fullScreenCover(isPresented: $fullScreen) {
      PlaceMapPreview(block: block, places: places, selected: $selected)
        .onDisappear { centered = selected }
        .navigationTransition(.zoom(sourceID: "place-map", in: morph))
    }
    .onChange(of: selected) { _, _ in remember() }
    // A message whose map is replaced starts fresh, without a phantom swipe.
    .onChange(of: block.placeIds) { _, _ in
      centered = nil; selected = nil; preview = nil
    }
    .onChange(of: preview?.id) { _, id in
      if id != nil { NotificationCenter.default.post(name: PlaceMapMemory.previewOpened, object: memoryKey) }
    }
    .onReceive(NotificationCenter.default.publisher(for: PlaceMapMemory.previewOpened)) { note in
      if (note.object as? String) != memoryKey, preview != nil { close() }
    }
    .onChange(of: preview?.id) { _, _ in remember() }
    .onChange(of: preview == nil) { _, closed in if closed { morphFromCard = true } }
  }

  private var carousel: some View {
    ScrollViewReader { proxy in
      ScrollView(.horizontal) {
        HStack(spacing: 10) {
          ForEach(Array(places.enumerated()), id: \.element.id) { index, place in
            let distance = Double(abs(index - (previewIndex ?? index)))
            // Only the neighbours animate on their own; the source card follows
            // the morph's transaction so both ends move on one spring.
            let hidden = preview != nil && preview?.id != place.id
            Group {
              if preview?.id == place.id {
                // The card has become the preview; keep its slot so neighbours stay put.
                Color.clear.frame(minHeight: 108)
              } else {
                Button { open(place) } label: {
                  PlaceCardFace(place: place, label: stopLabel(block.route, index), selected: selected == place.id,
                                namespace: morph, matches: morphFromCard, revealDelay: returning == place.id ? 0.12 : 0)
                }.buttonStyle(SquishButtonStyle(scale: 0.955)).accessibilityIdentifier("place-card-" + place.id)
                // The card hands over to the preview at once; only its glass and
                // photo carry on, as the preview's.
                .transition(.asymmetric(insertion: .identity, removal: .opacity.animation(.linear(duration: 0.05))))
              }
            }
            // Cards are sized from the map so the next one peeks in.
            .containerRelativeFrame(.horizontal) { width, _ in max(200, width - 40) }
            .id(place.id)
            // Cards leaving the snap point recede, so a moving card has depth.
            .scrollTransition(.interactive, axis: .horizontal) { content, phase in
              content.scaleEffect(reduceMotion ? 1 : 1 - abs(phase.value) * 0.07)
                .opacity(1 - abs(phase.value) * 0.2)
            }
            .opacity(hidden ? 0 : 1)
            .blur(radius: hidden ? 8 : 0)
            .scaleEffect(hidden ? 0.9 : 1)
            .offset(y: hidden ? 28 : 0)
            .animation(PlaceMotion.soft(reduceMotion).delay(reduceMotion ? 0 : distance * 0.015), value: hidden)
          }
        }.scrollTargetLayout().padding(.vertical, 12)
      }.contentMargins(.horizontal, 12, for: .scrollContent)
        .scrollIndicators(.hidden).scrollTargetBehavior(.viewAligned).accessibilityIdentifier("place-carousel")
        // Observe (never drive) which card is fully in view: each new one ticks
        // and becomes the map's selection, as swiping Apple Maps' cards does.
        .onScrollTargetVisibilityChange(idType: String.self, threshold: 0.95) { visible in
          guard let first = visible.first, first != centered else { return }
          let swiped = centered != nil && preview == nil && !fullScreen && !programmaticScroll
          centered = first
          if swiped {
            NativeHaptics.play(.selection, source: "place.carousel")
            selected = first
          }
        }
        .allowsHitTesting(preview == nil)
        .onChange(of: selected) { _, id in
          guard let id, id != centered else { return }
          programmaticScroll = true
          withAnimation(PlaceMotion.soft(reduceMotion)) { proxy.scrollTo(id, anchor: .leading) }
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { programmaticScroll = false }
        }
    }
  }
}

private struct PlaceCardFace: View {
  let place: PresentationPlace
  let label: String?
  let selected: Bool
  let namespace: Namespace.ID
  /// Whether this card is the preview's morph partner.
  var matches = true
  /// When a preview closes back into this card, its text waits for the glass.
  var revealDelay: Double = 0
  @State private var textShown = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var typeSize
  var body: some View {
    // At accessibility sizes the photo sits above the text so names stay whole.
    let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(spacing: 12))
    layout {
      PlaceThumbnail(source: place.imageUrl, name: place.name, size: typeSize.isAccessibilitySize ? 56 : 72, radius: 11, icon: place.icon)
        .placeMatch("thumb-" + place.id, in: namespace, enabled: matches && !reduceMotion)
      VStack(alignment: .leading, spacing: 1) {
        if let label { Text(label).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
        PlaceDetails(place: place)
      }.opacity(textShown ? 1 : 0)
    }
    .padding(14).frame(maxWidth: .infinity, minHeight: 100, alignment: .leading)
    // The selection ring is part of the surface, so it morphs instead of
    // lingering in the card's slot.
    .background {
      ZStack {
        PlaceGlass(radius: 24)
        RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(placeAccent, lineWidth: 1.5).opacity(selected ? 1 : 0)
          .animation(.easeOut(duration: 0.15), value: selected)
      }.placeMatch("surface-" + place.id, in: namespace, enabled: matches && !reduceMotion)
    }
    .contentShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(placeSpokenLabel(place, label))
    .accessibilityAddTraits(selected ? .isSelected : [])
    .onAppear {
      if revealDelay == 0 { textShown = true }
      else { withAnimation(.easeOut(duration: 0.12).delay(revealDelay)) { textShown = true } }
    }
  }
}

/// The tapped card, grown in place over the map, laid out like Apple Maps'
/// place card: centered title, action tiles, a stats row, photo, then details.
private struct PlaceInlineDetail: View {
  let place: PresentationPlace
  let label: String?
  let mode: String?
  let namespace: Namespace.ID
  /// False when the panel rises on its own (no card to grow out of).
  var morphs = true
  var maxHeight: CGFloat = inlineHeight
  /// Reports the panel's real (content-sized) height.
  var onHeight: ((CGFloat) -> Void)? = nil
  let onClose: () -> Void
  /// The inline panel leaves a band of map above it for the selected pin.
  static let inlineHeight: CGFloat = 270
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorScheme) private var scheme
  @Environment(\.dynamicTypeSize) private var typeSize
  /// The container and shared elements morph immediately; the rest follows.
  @State private var appeared = false
  /// After a place switch the content only cross-fades (no rise or blur).
  @State private var switched = false
  private var moves: Bool { !reduceMotion && !switched }
  private var limit: CGFloat { typeSize.isAccessibilitySize ? max(maxHeight, 330) : maxHeight }
  var body: some View {
    // A clear container offers the maximum height; the panel inside sizes to
    // its content (a max-height frame alone would always expand to the max).
    Color.clear.frame(maxWidth: .infinity).frame(height: limit)
      .overlay(alignment: .bottom) { panel }
      .allowsHitTesting(true)
  }
  private var panel: some View {
    VStack(spacing: 12) {
      // Only the glass and the photo are shared with the card: text can't
      // interpolate between the two layouts without ghosting, so the title
      // arrives with the rest of the content, as in Apple Maps' sheets.
      VStack(spacing: 2) {
        ViewThatFits(in: .horizontal) {
          title.font(.title2.weight(.bold)).lineLimit(1)
          title.font(.title3.weight(.bold)).lineLimit(1)
          title.font(.title3.weight(.bold)).lineLimit(typeSize.isAccessibilitySize ? 4 : 2)
        }
        subtitleView
      }.frame(maxWidth: .infinity).padding(.horizontal, 40)
        .fixedSize(horizontal: false, vertical: true)
        .entrance(appeared, 0, moves: moves)
      // Short content sizes the panel; long content scrolls inside it.
      ViewThatFits(in: .vertical) {
        details.fixedSize(horizontal: false, vertical: true)
        ScrollView { details }.scrollIndicators(.hidden).scrollBounceBehavior(.basedOnSize).softScrollEdges()
      }
    }
    .padding(.horizontal, 14).padding(.top, 16)
    .frame(maxWidth: .infinity)
    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onHeight?($0) }
    // Scrolled content stays inside the panel's rounded glass.
    .clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
    .background { PlaceGlass(radius: 30).placeMatch("surface-" + place.id, in: namespace, enabled: morphs && !reduceMotion) }
    .overlay(alignment: .topTrailing) {
      Button(action: onClose) { Image(systemName: "xmark").font(.system(size: 14, weight: .semibold)) }
        .buttonStyle(GlassCircleButtonStyle(size: 36)).padding(8)
        .scaleEffect(appeared ? 1 : 0.4).opacity(appeared ? 1 : 0)
        .accessibilityLabel("Close place details").accessibilityIdentifier("close-place-details")
    }
    .accessibilityElement(children: .contain).accessibilityIdentifier("place-details")
    .onAppear { withAnimation(PlaceMotion.soft(reduceMotion)) { appeared = true } }
    // Switching places keeps the panel; the new content cross-fades in.
    .onChange(of: place.id) { _, _ in
      // Reset first, then animate on the next pass; in one update the two
      // writes would collapse into no change at all.
      switched = true
      appeared = false
      DispatchQueue.main.async { withAnimation(PlaceMotion.swap) { appeared = true } }
    }
  }
  private var details: some View {
        VStack(alignment: .leading, spacing: 14) {
          GlassGroup { HStack(spacing: 8) {
            if let directions = directionsURL(place, mode) {
              Link(destination: directions) { tile("Directions", "arrow.triangle.turn.up.right.circle.fill", filled: true) }
                .buttonStyle(SquishButtonStyle(scale: 0.93, haptic: true))
            }
            if let website = presentationURL(place.websiteUrl) {
              Link(destination: website) { tile("Website", "safari.fill") }.buttonStyle(SquishButtonStyle(scale: 0.93, haptic: true))
            }
            // Closing plays its own haptic; no second tap on press.
            Button(action: onClose) { tile("Map", "map.fill") }.buttonStyle(SquishButtonStyle(scale: 0.93))
              .accessibilityLabel("Back to map").accessibilityIdentifier("place-detail-back")
          } }.entrance(appeared, 1, moves: moves)
          stats.entrance(appeared, 2, moves: moves)
          if let image = presentationURL(place.imageUrl) {
            // A flexible clear frame sized by the panel, with the image laid over
            // it: a fill image's own ideal width can't widen the panel.
            Color.clear.frame(maxWidth: .infinity).frame(height: 150)
              .overlay { CachedImage(url: image) { Color.secondary.opacity(0.16) } }
              .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
              .placeMatch("thumb-" + place.id, in: namespace, enabled: morphs && !reduceMotion).accessibilityHidden(true)
          }
          if let description = place.description {
            section("About") { Text(description).font(.subheadline).fixedSize(horizontal: false, vertical: true) }.entrance(appeared, 3, moves: moves)
          }
          if place.hours != nil || place.address != nil || place.notes != nil {
            section("Details") {
              VStack(alignment: .leading, spacing: 0) {
                let rows = [("Hours", place.hours), ("Address", place.address), ("Note", place.notes)].compactMap { label, value in value.map { (label, $0) } }
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                  if index > 0 { Divider() }
                  VStack(alignment: .leading, spacing: 2) {
                    Text(row.0).font(.caption).foregroundStyle(.secondary)
                    Text(row.1).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                  }.padding(.vertical, 9).frame(maxWidth: .infinity, alignment: .leading)
                }
              }
            }.entrance(appeared, 4, moves: moves)
          }
          if presentationURL(place.sourceUrl) != nil || place.attribution != nil {
            VStack(alignment: .leading, spacing: 4) {
              if let source = presentationURL(place.sourceUrl) {
                Link(destination: source) { Text("More on \(place.provider ?? "the source")").font(.footnote.weight(.medium)).foregroundStyle(placeAccent) }
              }
              if let attribution = place.attribution { Text(attribution).font(.caption2).foregroundStyle(.secondary) }
            }.entrance(appeared, 5, moves: moves)
          }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 16)
  }
  private var title: some View {
    Text(place.name).foregroundStyle(NativePalette.text).multilineTextAlignment(.center)
  }
  /// "Start here · Observation deck" on one line, or the two parts on their
  /// own lines; never a separator dangling at a line end.
  @ViewBuilder private var subtitleView: some View {
    let parts = [label, place.category].compactMap { $0 }
    if !parts.isEmpty {
      ViewThatFits(in: .horizontal) {
        Text(parts.joined(separator: " · ")).lineLimit(1)
        VStack(spacing: 0) { ForEach(parts, id: \.self) { Text($0).lineLimit(typeSize.isAccessibilitySize ? 3 : 1) } }
      }.font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
    }
  }
  private func tile(_ title: String, _ icon: String, filled: Bool = false) -> some View {
    // Apple's buttons: a filled accent primary, neutral glass secondaries with an
    // accent (light) or white (dark) label, and icons on a shared baseline. At
    // accessibility sizes the labels drop and the icons carry the meaning.
    VStack(spacing: 3) {
      Image(systemName: icon).font(.body.weight(.semibold)).frame(height: 22)
      if !typeSize.isAccessibilitySize {
        Text(title).font(.caption.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.75)
      }
    }.padding(.horizontal, 6).frame(maxWidth: .infinity, minHeight: 44).padding(.vertical, 3)
      .foregroundStyle(filled || scheme == .dark ? Color.white : placeAccent)
      .liquidGlass(RoundedRectangle(cornerRadius: 12, style: .continuous), tint: filled ? placeAccent : nil, interactive: true)
      .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
      .accessibilityLabel(title)
  }
  @ViewBuilder private var stats: some View {
    // As in Apple Maps: Hours, then the rating under its review count (or
    // its provider); the provider's link sits at the end of the card.
    let ratingHeader = place.reviewCount.map { _ in ratingsLabel(place.reviewCount) } ?? place.provider ?? "Rating"
    if place.isOpen != nil || place.rating != nil {
      HStack(alignment: .top, spacing: 0) {
        if let open = place.isOpen {
          statColumn("Hours") { Text(open ? "Open" : "Closed").foregroundStyle(open ? Color.green : Color.red) }
        }
        if let rating = place.rating {
          statColumn(ratingHeader) {
            HStack(spacing: 3) { Image(systemName: "star.fill").foregroundStyle(Color.orange).accessibilityHidden(true); Text(formatRating(rating)) }
              .accessibilityLabel("\(formatRating(rating)) stars")
          }
        }
      }
    }
  }
  private func statColumn(_ header: String, @ViewBuilder value: () -> some View) -> some View {
    VStack(spacing: 2) {
      Text(header).font(.caption).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.center)
      value().font(.callout.weight(.semibold)).lineLimit(typeSize.isAccessibilitySize ? 2 : 1).minimumScaleFactor(0.8)
    }.frame(maxWidth: .infinity)
    // One spoken element per column: "Hours, Open", then "128 Ratings, 4.5 stars".
    .accessibilityElement(children: .combine)
  }
  private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(.headline)
      content().padding(.horizontal, 12).padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading)
        .liquidGlass(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
  }
}
private extension View {
  /// Staggered rise-and-focus as the preview grows; opacity only when `moves`
  /// is off (place switches and Reduce Motion).
  func entrance(_ appeared: Bool, _ index: Int, moves: Bool) -> some View {
    opacity(appeared ? 1 : 0).offset(y: appeared || !moves ? 0 : 10).blur(radius: appeared || !moves ? 0 : 4)
      .animation(moves ? .spring(response: 0.24, dampingFraction: 0.86).delay(appeared ? 0.02 * Double(index) : 0) : nil, value: appeared)
  }
}

private struct NativePlaceMap: View {
  let places: [PresentationPlace]
  let route: PresentationRoute?
  @Binding var selected: String?
  var hasCards = false
  /// Points of map covered by glass at the bottom (cards or the preview);
  /// MapKit frames places inside the rest, and its logo and Legal stay visible.
  var obscuredBottom: CGFloat = 0
  /// Glass covering the top (fullscreen: status bar and close button).
  var obscuredTop: CGFloat = 0
  /// With the preview open: the y of its top edge. The selected pin is placed
  /// in the band above it by moving the camera, not the safe area.
  var panelTop: CGFloat? = nil
  /// Keep pins clear of a floating itinerary panel (bottom fraction of the map).
  var bottomInset: Double = 0
  var onPin: ((PresentationPlace) -> Void)?
  @State private var camera: MapCameraPosition
  /// Measured from the live map: its height and degrees of latitude per point.
  @State private var mapHeight: CGFloat = 0
  @State private var degreesPerPoint: Double = 0
  /// Computed once per map: a thinned route line and fan-outs for shared spots.
  @State private var routeLine: [CLLocationCoordinate2D] = []
  @State private var fanOffsets: [String: CGFloat] = [:]
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  init(places: [PresentationPlace], route: PresentationRoute?, selected: Binding<String?>, hasCards: Bool = false,
       obscuredBottom: CGFloat = 0, obscuredTop: CGFloat = 0, panelTop: CGFloat? = nil, bottomInset: Double = 0,
       onPin: ((PresentationPlace) -> Void)? = nil) {
    self.places = places; self.route = route; _selected = selected; self.hasCards = hasCards
    self.obscuredBottom = obscuredBottom; self.obscuredTop = obscuredTop; self.panelTop = panelTop
    self.bottomInset = bottomInset; self.onPin = onPin
    // Start framed, so a fullscreen zoom never lands on an empty grid.
    _camera = State(initialValue: .region(Self.fittedRegion(places, route, bottomInset)))
    _routeLine = State(initialValue: route.map { displayRoute($0.geometry.coordinates) } ?? [])
    _fanOffsets = State(initialValue: pinFanOffsets(places))
  }
  private static func fittedRegion(_ places: [PresentationPlace], _ route: PresentationRoute?, _ bottomInset: Double) -> MKCoordinateRegion {
    // Fit in map (Mercator) space, so continent-scale routes frame correctly;
    // a route across the antimeridian keeps the degree-based fit below.
    let all = places.map { [$0.longitude, $0.latitude] } + (route?.geometry.coordinates ?? [])
    let lngs = all.map { $0[0] }
    if (lngs.max() ?? 0) - (lngs.min() ?? 0) <= 180, !all.isEmpty {
      let points = all.map { MKMapPoint(CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0])) }
      let minX = points.map(\.x).min()!, maxX = points.map(\.x).max()!, minY = points.map(\.y).min()!, maxY = points.map(\.y).max()!
      // At least ~1.2 km across, and 20% padding on every side.
      let floor = MKMapPointsPerMeterAtLatitude(all[0][1]) * 1200
      let width = max(maxX - minX, floor), height = max(maxY - minY, floor)
      let rect = MKMapRect(x: (minX + maxX) / 2 - width * 0.7, y: (minY + maxY) / 2 - height * 0.7, width: width * 1.4, height: height * 1.4)
      return MKCoordinateRegion(rect)
    }
    let latitudes = places.map(\.latitude) + (route?.geometry.coordinates.map { $0[1] } ?? [])
    let longitudes = places.map(\.longitude) + (route?.geometry.coordinates.map { $0[0] } ?? [])
    let minLat = latitudes.min() ?? 0, maxLat = latitudes.max() ?? 0
    let crossing = (longitudes.max() ?? 0) - (longitudes.min() ?? 0) > 180
    let lng = longitudes.map { crossing && $0 < 0 ? $0 + 360 : $0 }
    let minLng = lng.min() ?? 0, maxLng = lng.max() ?? 0
    let centerLng = (minLng + maxLng) / 2
    let span = max(0.012, (maxLat - minLat) * (bottomInset > 0 ? 2.2 / (1 - bottomInset) : 2.1))
    let lift = bottomInset * 0.5
    return MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: min(85, max(-85, (minLat + maxLat) / 2 - span * lift)), longitude: centerLng > 180 ? centerLng - 360 : centerLng), span: MKCoordinateSpan(latitudeDelta: min(170, span), longitudeDelta: min(350, max(0.015, (maxLng - minLng) * 1.8))))
  }
  private var region: MKCoordinateRegion { Self.fittedRegion(places, route, bottomInset) }
  private func focus(_ id: String?) {
    let fitted = region
    guard let place = places.first(where: { $0.id == id }) else {
      withAnimation(reduceMotion ? nil : PlaceMotion.camera) { camera = .region(fitted) }
      return
    }
    // Where the place's point should land on screen: just above the preview's
    // top edge (the pin stands ~60pt tall on it), or a little below the centre
    // of the uncovered map so the pin body is what's centred.
    let visibleCentre = obscuredTop + (mapHeight - obscuredTop - obscuredBottom) / 2
    // (MapKit fits the region by its wider axis, so the measured degrees per
    // point run slightly high; the extra margin keeps the tail off the glass.)
    let target = panelTop.map { $0 - 24 } ?? visibleCentre + 22
    let offset = mapHeight > 0 && degreesPerPoint > 0 ? Double(target - visibleCentre) * degreesPerPoint : 0
    // If another stop would sit under this pin, zoom in just enough that the
    // nearest one separates (a pin is ~44pt wide; aim for ~56pt apart).
    var span = fitted.span
    if degreesPerPoint > 0 {
      let nearest = places.filter { $0.id != place.id }
        .map { hypot($0.latitude - place.latitude, ($0.longitude - place.longitude) * cos(place.latitude * .pi / 180)) }.min()
      if let nearest, nearest / degreesPerPoint < 56 {
        let factor = max(0.15, nearest / degreesPerPoint / 56)
        span = MKCoordinateSpan(latitudeDelta: span.latitudeDelta * factor, longitudeDelta: span.longitudeDelta * factor)
      }
    }
    let zoom = span.latitudeDelta / fitted.span.latitudeDelta
    let focus = MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: min(85, max(-85, place.latitude + offset * zoom)), longitude: place.longitude), span: span)
    withAnimation(reduceMotion ? nil : PlaceMotion.camera) { camera = .region(focus) }
  }
  var body: some View {
    Map(position: $camera) {
      if !routeLine.isEmpty {
        MapPolyline(coordinates: routeLine)
          .stroke(.blue.opacity(0.18), style: StrokeStyle(lineWidth: 9, lineCap: .round, lineJoin: .round))
        MapPolyline(coordinates: routeLine)
          .stroke(.blue, style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [0.5, 5]))
      }
      ForEach(Array(places.enumerated()), id: \.element.id) { index, place in
        // The tail dot stands on the place, as with Apple's pins. Long names
        // only label the selected pin, so they don't blanket the map.
        Annotation(place.name, coordinate: CLLocationCoordinate2D(latitude: place.latitude, longitude: place.longitude), anchor: .bottom) {
          Button {
            if let onPin { onPin(place) }
            else if selected != place.id { NativeHaptics.play(.selection, source: "place.pin"); selected = place.id }
          } label: {
            PlacePin(index: index, place: place, numbered: route != nil, selected: selected == place.id)
              .offset(x: fanOffsets[place.id] ?? 0)
          }.buttonStyle(SquishButtonStyle(scale: 0.88)).accessibilityLabel(place.name).accessibilityIdentifier("place-pin-" + place.id)
            .accessibilityAddTraits(selected == place.id ? .isSelected : [])
        }.annotationTitles(place.name.count > 24 && selected != place.id ? .hidden : .automatic)
      }
    }
    // Apple's own landmark photo pins would read as stops; leave them out.
    .mapStyle(.standard(elevation: .flat, pointsOfInterest: .excluding([.landmark, .museum, .library, .nationalMonument, .castle])))
    .mapControls { MapCompass(); MapScaleView() }
      .safeAreaPadding(.bottom, obscuredBottom).safeAreaPadding(.top, obscuredTop)
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { mapHeight = $0 }
      .onMapCameraChange(frequency: .onEnd) { context in
        // MapKit reports the region of the safe-area-inset viewport.
        let visible = mapHeight - obscuredTop - obscuredBottom
        if visible > 0 { degreesPerPoint = context.region.span.latitudeDelta / Double(visible) }
      }
      .onChange(of: selected) { _, id in focus(id) }
      .onChange(of: panelTop) { _, _ in focus(selected) }
  }
}
/// Apple Maps landmark pin: the place photo in a white ring over a tail dot.
/// Selecting it lands like jelly: stretch up, squash, settle.
private struct PlacePin: View {
  let index: Int
  let place: PresentationPlace
  let numbered: Bool
  let selected: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private struct Jelly { var x = 1.0; var y = 1.0 }
  /// Bumped only when the pin becomes selected, so deselecting doesn't wobble.
  @State private var landings = 0
  @State private var photoLoaded = false
  var body: some View {
    VStack(spacing: 3) {
      ZStack(alignment: .topTrailing) {
        face
          .frame(width: 32, height: 32).clipShape(Circle())
          .padding(3).liquidGlass(Circle(), tint: selected ? placeAccent : .white.opacity(0.35), interactive: true)
          .shadow(color: .black.opacity(0.28), radius: selected ? 8 : 4, y: 2)
        if numbered && photoLoaded {
          Text(String(index + 1)).font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
            .frame(minWidth: 17, minHeight: 17).liquidGlass(Capsule(), tint: placeAccent).offset(x: 5, y: -4)
        }
      }
      Circle().fill(.clear).frame(width: 6, height: 6).liquidGlass(Circle(), tint: placeAccent.opacity(0.6))
    }
    .keyframeAnimator(initialValue: Jelly(), trigger: landings) { content, jelly in
      content.scaleEffect(x: jelly.x, y: jelly.y, anchor: .bottom)
    } keyframes: { _ in
      KeyframeTrack(\.x) {
        SpringKeyframe(0.95, duration: 0.07); SpringKeyframe(1.04, duration: 0.08); SpringKeyframe(1, duration: 0.12)
      }
      KeyframeTrack(\.y) {
        SpringKeyframe(1.08, duration: 0.07); SpringKeyframe(0.95, duration: 0.08); SpringKeyframe(1, duration: 0.12)
      }
    }
    .scaleEffect(selected ? 1.28 : 1, anchor: .bottom)
    .animation(reduceMotion ? nil : .spring(response: 0.22, dampingFraction: 0.72), value: selected)
    .onChange(of: selected) { _, isSelected in if isSelected && !reduceMotion { landings += 1 } }
  }
  @ViewBuilder private var face: some View {
    if let url = presentationURL(place.imageUrl) {
      CachedImage(url: url, onLoad: { photoLoaded = $0 }) { solid }
    } else { solid }
  }
  private var solid: some View {
    ZStack {
      placeAccent
      if numbered { Text(String(index + 1)).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white) }
      else if let icon = placeGlyph(place.icon) { Text(icon).font(.system(size: 15)) }
      else { Circle().fill(.white).frame(width: 9, height: 9) }
    }
  }
}

private struct PlaceMapPreview: View {
  let block: PresentationMap
  let places: [PresentationPlace]
  @Binding var selected: String?
  @State private var appeared = false
  /// A place opened from the list or a pin takes the list's slot, as on desktop.
  @State private var preview: PresentationPlace?
  @Namespace private var cardSpace
  @Environment(\.dismiss) private var dismiss
  @Environment(\.horizontalSizeClass) private var sizeClass
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    GeometryReader { screen in
      let regular = sizeClass == .regular
      // The sheet hugs its content up to 46% of the screen (phones), and the
      // map frames every stop between the status bar and the sheet.
      let sheetMax = regular ? screen.size.height : screen.size.height * 0.46
      ZStack(alignment: regular ? .trailing : .bottom) {
        NativePlaceMap(places: places, route: block.route, selected: $selected,
                       obscuredBottom: regular ? 0 : sheetMax + 12 + screen.safeAreaInsets.bottom, obscuredTop: screen.safeAreaInsets.top + 56,
                       onPin: { place in show(place) })
          .padding(.leading, regular ? 0 : 0).padding(.trailing, regular ? 374 : 0)
          .ignoresSafeArea()
        Group {
          if let preview {
            PlaceInlineDetail(place: preview, label: places.firstIndex(where: { $0.id == preview.id }).flatMap { stopLabel(block.route, $0) },
                              mode: block.route?.mode, namespace: cardSpace, maxHeight: sheetMax, onClose: hideCard)
              .geometryGroup()
              .transition(reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
          } else {
            itinerary(maxHeight: sheetMax).transition(.opacity)
          }
        }
        .frame(width: regular ? 360 : nil)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: regular ? .trailing : .bottom)
        .padding(12)
        .offset(x: appeared || !regular || reduceMotion ? 0 : 60, y: appeared || regular || reduceMotion ? 0 : 80)
        .opacity(appeared ? 1 : 0)
      }
    }
    .overlay(alignment: .topLeading) {
      Button {
        NativeHaptics.play(.light, intensity: 0.55, source: "place.map.close")
        // The card stays behind; only the map zooms back into the chat.
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { preview = nil }
        dismiss()
      } label: { Image(systemName: "xmark").font(.system(size: 16, weight: .semibold)) }
        .buttonStyle(GlassCircleButtonStyle(size: 44)).padding(.horizontal, 16).padding(.top, 4)
        .accessibilityLabel("Close map").accessibilityIdentifier("close-place-map")
    }
    .background(NativePalette.background)
    .onAppear { withAnimation(PlaceMotion.morph(reduceMotion)) { appeared = true } }
  }
  private func show(_ place: PresentationPlace) {
    guard preview?.id != place.id else { return }
    selected = place.id
    if preview == nil {
      NativeHaptics.play(.soft, intensity: 0.8, source: "place.open")
      withAnimation(PlaceMotion.morph(reduceMotion)) { preview = place }
    } else {
      // Switching keeps the card in place and cross-fades its content.
      NativeHaptics.play(.selection, source: "place.selection")
      var transaction = Transaction()
      transaction.disablesAnimations = true
      withTransaction(transaction) { preview = place }
    }
  }
  private func hideCard() {
    NativeHaptics.play(.light, intensity: 0.55, source: "place.close")
    withAnimation(PlaceMotion.settle(reduceMotion)) { preview = nil }
  }
  private func itinerary(maxHeight: CGFloat) -> some View {
    // Short lists hug their content; long ones scroll inside the glass.
    ViewThatFits(in: .vertical) {
      itineraryContent.fixedSize(horizontal: false, vertical: true)
      ScrollViewReader { proxy in
        ScrollView { itineraryContent }
          .scrollIndicators(.hidden).softScrollEdges()
          // Open on the place that was selected inline, keeping the header in
          // view when that's the first stop.
          .onAppear { if let selected, selected != places.first?.id { proxy.scrollTo(selected, anchor: .center) } }
      }
    }
    .frame(maxHeight: maxHeight)
    .background { PlaceGlass(radius: 30) }
    .clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
    .accessibilityIdentifier("place-itinerary")
  }
  private var itineraryContent: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("\(places.count) \(places.count == 1 ? "PLACE" : "PLACES")").font(.caption.weight(.semibold)).tracking(0.4).foregroundStyle(.secondary)
      Text(block.title ?? "Your places").font(.title3.weight(.semibold)).padding(.top, 6)
      if let route = block.route {
        // Chips wrap to a column at large text sizes instead of clipping.
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 6) { routeChips(route) }
          VStack(alignment: .leading, spacing: 6) { routeChips(route) }
        }.padding(.top, 12)
      }
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(places.enumerated()), id: \.element.id) { index, place in
          stop(index, place).id(place.id)
            .opacity(appeared ? 1 : 0).offset(y: appeared || reduceMotion ? 0 : 10)
            .animation(PlaceMotion.soft(reduceMotion).delay(reduceMotion ? 0 : 0.06 + Double(min(index, 6)) * 0.02), value: appeared)
        }
      }.padding(.top, 20)
      if let attribution = block.route?.attribution { Text(attribution).font(.caption2).foregroundStyle(.secondary).padding(.top, 8) }
    }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
  }
  @ViewBuilder private func routeChips(_ route: PresentationRoute) -> some View {
    chip(modeName(route), accent: true)
    chip(Measurement(value: route.distanceMeters, unit: UnitLength.meters).formatted(.measurement(width: .abbreviated, usage: .road)))
    chip(travelTime(route.durationSeconds))
  }
  private func chip(_ text: String, accent: Bool = false) -> some View {
    Text(text).font(.caption.weight(.medium)).lineLimit(1).fixedSize().padding(.horizontal, 10).padding(.vertical, 5)
      .foregroundStyle(accent ? placeAccent : NativePalette.text)
      .liquidGlass(Capsule(), tint: accent ? placeAccent.opacity(0.22) : nil)
  }
  private func stop(_ index: Int, _ place: PresentationPlace) -> some View {
    HStack(alignment: .top, spacing: 12) {
      VStack(spacing: 0) {
        Group {
          if block.route != nil { Text(String(index + 1)).font(.caption.weight(.semibold)) }
          else { Circle().frame(width: 8, height: 8) }
        }.foregroundStyle(placeAccent)
          .frame(width: 24, height: 24).liquidGlass(Circle(), tint: placeAccent.opacity(0.2))
          .overlay(Circle().strokeBorder(placeAccent, lineWidth: 1.5))
        if index < places.count - 1 {
          Line().stroke(placeAccent.opacity(0.45), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [0.5, 4])).frame(width: 2)
        }
      }
      VStack(alignment: .leading, spacing: 8) {
        if block.route != nil {
          Text(index == 0 ? "Start here" : index == places.count - 1 ? "Destination" : "Stop \(index + 1)").font(.caption).foregroundStyle(.secondary).frame(height: 24)
        }
        Button { show(place) } label: {
          HStack(spacing: 12) { PlaceThumbnail(source: place.imageUrl, name: place.name, icon: place.icon); PlaceDetails(place: place) }
            .padding(8).background {
              if selected == place.id { Color.clear.liquidGlass(RoundedRectangle(cornerRadius: 16, style: .continuous), tint: placeAccent.opacity(0.18)) }
            }
        }.buttonStyle(SquishButtonStyle(scale: 0.98)).padding(.horizontal, -8)
          .accessibilityAddTraits(selected == place.id ? .isSelected : [])
        if let notes = place.notes { Text(notes).font(.footnote).foregroundStyle(.secondary) }
        if let address = place.address { Text(address).font(.caption).foregroundStyle(.secondary) }
        if let source = presentationURL(place.sourceUrl) { Link(place.provider ?? "Source", destination: source).font(.caption.weight(.medium)).foregroundStyle(placeAccent) }
        if let route = block.route, index < route.legs.count {
          Text("\(modeName(route)) ~\(travelTime(route.legs[index].durationSeconds))").font(.caption).foregroundStyle(.secondary)
            .padding(.horizontal, 9).padding(.vertical, 3).liquidGlass(Capsule())
        }
      }.padding(.bottom, 18)
    }
  }
}
private struct Line: Shape {
  func path(in rect: CGRect) -> Path { Path { $0.move(to: CGPoint(x: rect.midX, y: rect.minY + 4)); $0.addLine(to: CGPoint(x: rect.midX, y: rect.maxY - 2)) } }
}

private struct PresentationMediaView: View {
  let block: PresentationMedia
  let places: [PresentationPlace]
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let title = block.title { Text(title).font(.headline).padding(.bottom, 8) }
      ForEach(Array(block.items.enumerated()), id: \.element.id) { index, item in
        let row = HStack(alignment: .top, spacing: 14) {
          ZStack(alignment: .topLeading) {
            PlaceThumbnail(source: item.imageUrl ?? places.first(where: { $0.id == item.placeId })?.imageUrl, name: item.title, size: 92, radius: 18,
                           icon: places.first(where: { $0.id == item.placeId })?.icon)
            RankBadge(rank: index + 1).padding(6).accessibilityHidden(true)
          }
          VStack(alignment: .leading, spacing: 5) {
            Text(item.title).font(.body.weight(.semibold)).foregroundStyle(NativePalette.text).fixedSize(horizontal: false, vertical: true)
              .accessibilityLabel("\(index + 1). \(item.title)")
            if let description = item.description { Text(description).font(.subheadline).foregroundStyle(NativePalette.text.opacity(0.82)).lineSpacing(2).fixedSize(horizontal: false, vertical: true) }
            if let source = presentationURL(item.sourceUrl) {
              Link(destination: source) {
                Label(item.sourceLabel ?? "Source", systemImage: "arrow.up.right").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                  .lineLimit(1).truncationMode(.tail)
                  .padding(.horizontal, 9).padding(.vertical, 4).liquidGlass(Capsule(), interactive: true)
              }.padding(.top, 3)
            }
          }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 2)
        }.padding(8).contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
          // Combine keeps the description; the rank is spoken with the title.
          .accessibilityElement(children: .combine)
        Group {
          if let link = presentationURL(item.href) { Link(destination: link) { row }.buttonStyle(SquishButtonStyle(scale: 0.98)) }
          else { row }
        }.padding(.horizontal, -8)
      }
    }
  }
}
private struct RankBadge: View {
  let rank: Int
  var body: some View {
    let label = Text(String(rank)).font(.system(size: 13, weight: .bold)).monospacedDigit().foregroundStyle(.white)
      .shadow(color: .black.opacity(0.3), radius: 1, y: 0.5).frame(minWidth: 26, minHeight: 26)
    if #available(iOS 26, *) {
      label.glassEffect(.regular.tint(.black.opacity(0.5)), in: Capsule())
    } else {
      label.background(.ultraThinMaterial.opacity(0.9), in: Capsule()).environment(\.colorScheme, .dark)
        .overlay(Capsule().strokeBorder(.white.opacity(0.45), lineWidth: 0.5))
    }
  }
}
