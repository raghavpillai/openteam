import SwiftUI
import MapKit

private func presentationURL(_ value: String?) -> URL? {
  guard let value, let url = URL(string: value), url.scheme == "https", url.user == nil, url.password == nil else { return nil }
  return url
}
private func travelTime(_ seconds: Double) -> String { seconds < 60 ? "<1 min" : "\(Int((seconds / 60).rounded())) min" }
private func modeName(_ route: PresentationRoute) -> String { route.mode == "walking" ? "Walk" : route.mode == "cycling" ? "Cycle" : "Drive" }

private struct MapControlButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.foregroundStyle(NativePalette.text).frame(width: 44, height: 44)
      .background(.regularMaterial, in: Circle())
      .overlay(Circle().stroke(NativePalette.separator.opacity(0.6), lineWidth: 0.5))
      .shadow(color: .black.opacity(0.12), radius: 10, x: 0, y: 3)
      .scaleEffect(configuration.isPressed ? 0.94 : 1)
      .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
      .contentShape(Circle())
  }
}

struct PresentationMessageView: View {
  let presentation: PresentationPayload
  var body: some View {
    VStack(alignment: .leading, spacing: 24) {
      ForEach(Array(presentation.blocks.enumerated()), id: \.offset) { _, block in
        switch block {
        case .markdown(let text):
          if RichMarkdownView.required(text) { RichMarkdownView(source: text).frame(maxWidth: .infinity) }
          else { MarkdownText(source: text).font(.body).fixedSize(horizontal: false, vertical: true) }
        case .map(let map): PresentationMapView(block: map, allPlaces: presentation.places)
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
  var body: some View {
    AsyncImage(url: presentationURL(source)) { phase in
      if let image = phase.image { image.resizable().scaledToFill() }
      else { ZStack { NativePalette.surface; Image(systemName: "mappin.and.ellipse").foregroundStyle(.secondary) } }
    }.frame(width: size, height: size).clipShape(RoundedRectangle(cornerRadius: size > 90 ? 17 : 12))
      .accessibilityHidden(true)
  }
}
private struct PlaceDetails: View {
  let place: PresentationPlace
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(place.name).font(.system(size: 15, weight: .medium)).foregroundStyle(NativePalette.text).lineLimit(2)
      HStack(spacing: 4) {
        if let rating = place.rating { Image(systemName: "star.fill"); Text(rating, format: .number.precision(.fractionLength(1))) }
        if let provider = place.provider { Text(provider).font(.system(size: 10)).lineLimit(1) }
        if let category = place.category { Text((place.rating != nil || place.provider != nil ? "· " : "") + category).lineLimit(1) }
      }.font(.system(size: 12)).foregroundStyle(NativePalette.text)
      if let open = place.isOpen { Text(open ? "Open" : "Closed").font(.system(size: 13)).foregroundStyle(open ? Color.green : Color.red) }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}
private struct PresentationMapView: View {
  let block: PresentationMap
  let allPlaces: [PresentationPlace]
  @State private var selected: String?
  @State private var fullScreen = false
  @State private var preview: PresentationPlace?
  @State private var showMapAfterPreview = false
  private var places: [PresentationPlace] { block.placeIds.compactMap { id in allPlaces.first { $0.id == id } } }
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if let title = block.title { Text(title).font(.headline) }
      ZStack(alignment: .bottom) {
        NativePlaceMap(places: places, route: block.route, selected: $selected, hasCards: block.carousel != "hidden")
        if block.carousel != "hidden" {
          ScrollViewReader { proxy in
            ScrollView(.horizontal) {
              HStack(spacing: 10) {
                ForEach(Array(places.enumerated()), id: \.element.id) { index, place in
                  Button { selected = place.id; preview = place; NativeHaptics.play(.selection, source: "place.selection") } label: {
                    HStack(spacing: 12) {
                      PlaceThumbnail(source: place.imageUrl, name: place.name)
                      VStack(alignment: .leading, spacing: 2) {
                        if let route = block.route {
                          Text(index == 0 ? "Start here" : index - 1 < route.legs.count ? "\(modeName(route)) ~\(travelTime(route.legs[index - 1].durationSeconds))" : "Stop \(index + 1)")
                            .font(.system(size: 13)).foregroundStyle(.secondary)
                        }
                        PlaceDetails(place: place)
                      }
                    }.padding(12).frame(width: 290, alignment: .leading)
                      .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                      .overlay(RoundedRectangle(cornerRadius: 16).stroke(selected == place.id ? Color.blue : NativePalette.separator, lineWidth: 1))
                  }.buttonStyle(.plain).id(place.id).accessibilityIdentifier("place-card-" + place.id)
                }
              }.scrollTargetLayout().padding(.horizontal, 12).padding(.vertical, 12)
            }.scrollIndicators(.hidden).scrollTargetBehavior(.viewAligned).accessibilityIdentifier("place-carousel")
              .onChange(of: selected) { _, id in if let id { withAnimation { proxy.scrollTo(id, anchor: .center) } } }
          }
        }
      }.frame(height: 360).clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(alignment: .topTrailing) {
          Button { fullScreen = true; NativeHaptics.play(.light, source: "place.expand") } label: { Image(systemName: "arrow.up.left.and.arrow.down.right").font(.system(size: 18, weight: .semibold)) }
            .buttonStyle(MapControlButtonStyle()).padding(12).accessibilityLabel("Open map full screen").accessibilityHint("View the map and all itinerary stops").accessibilityIdentifier("expand-place-map")
        }
    }.fullScreenCover(isPresented: $fullScreen) { PlaceMapPreview(block: block, places: places, selected: $selected) }
      .sheet(item: $preview, onDismiss: {
        if showMapAfterPreview { showMapAfterPreview = false; fullScreen = true }
      }) { place in
        PlaceDetailSheet(place: place, onShowMap: { showMapAfterPreview = true; preview = nil })
          .presentationDetents([.medium, .large]).presentationDragIndicator(.visible).presentationCornerRadius(28)
      }
  }
}
private struct NativePlaceMap: View {
  let places: [PresentationPlace]
  let route: PresentationRoute?
  @Binding var selected: String?
  var hasCards = false
  @State private var camera: MapCameraPosition = .automatic
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private var region: MKCoordinateRegion {
    let latitudes = places.map(\.latitude) + (route?.geometry.coordinates.map { $0[1] } ?? [])
    let longitudes = places.map(\.longitude) + (route?.geometry.coordinates.map { $0[0] } ?? [])
    let minLat = latitudes.min() ?? 0, maxLat = latitudes.max() ?? 0
    let crossing = (longitudes.max() ?? 0) - (longitudes.min() ?? 0) > 180
    let lng = longitudes.map { crossing && $0 < 0 ? $0 + 360 : $0 }
    let minLng = lng.min() ?? 0, maxLng = lng.max() ?? 0
    let centerLng = (minLng + maxLng) / 2
    let span = max(0.012, (maxLat - minLat) * (hasCards ? 3.4 : 2))
    return MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: min(85, max(-85, (minLat + maxLat) / 2 - (hasCards ? span * 0.12 : 0))), longitude: centerLng > 180 ? centerLng - 360 : centerLng), span: MKCoordinateSpan(latitudeDelta: min(170, span), longitudeDelta: min(350, max(0.015, (maxLng - minLng) * 1.8))))
  }
  var body: some View {
    Map(position: $camera) {
      if let route {
        MapPolyline(coordinates: route.geometry.coordinates.map { CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) })
          .stroke(.blue, style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [0.5, 5]))
      }
      ForEach(Array(places.enumerated()), id: \.element.id) { index, place in
        Annotation(place.name, coordinate: CLLocationCoordinate2D(latitude: place.latitude, longitude: place.longitude), anchor: .center) {
          Button { selected = place.id } label: {
            Group {
              if route != nil { Text(String(index + 1)).font(.system(size: 14, weight: .medium)) }
              else if let icon = place.icon, icon.unicodeScalars.contains(where: { $0.properties.isEmojiPresentation }) { Text(icon).font(.system(size: 16)) }
              else { Image(systemName: "mappin").font(.system(size: 14)) }
            }.frame(width: 30, height: 30)
              .foregroundStyle(selected == place.id ? Color.white : Color.blue)
              .background(selected == place.id ? Color.blue : NativePalette.surface, in: Circle())
              .overlay(Circle().stroke(Color.blue.opacity(0.7), lineWidth: 1))
          }.buttonStyle(.plain).accessibilityLabel(place.name).accessibilityIdentifier("place-pin-" + place.id)
        }
      }
    }.mapStyle(.standard(elevation: .flat)).mapControls { MapCompass(); MapScaleView() }
      .onAppear { camera = .region(region) }
      .onChange(of: selected) { _, id in
        guard let place = places.first(where: { $0.id == id }) else { return }
        let focus = MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: min(85, max(-85, place.latitude - (hasCards ? region.span.latitudeDelta * 0.12 : 0))), longitude: place.longitude), span: region.span)
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) { camera = .region(focus) }
      }
  }
}
private struct PlaceMapPreview: View {
  let block: PresentationMap
  let places: [PresentationPlace]
  @Binding var selected: String?
  @Environment(\.dismiss) private var dismiss
  @Environment(\.horizontalSizeClass) private var sizeClass
  var body: some View {
    GeometryReader { geometry in
      Group {
        if sizeClass == .regular { HStack(spacing: 0) { map; itinerary.frame(width: 350) } }
        else { VStack(spacing: 0) { map.frame(height: geometry.size.height * 0.53); itinerary } }
      }.background(NativePalette.background)
    }.ignoresSafeArea(edges: .bottom)
  }
  private var map: some View {
    NativePlaceMap(places: places, route: block.route, selected: $selected)
      .overlay(alignment: .topLeading) {
        Button { dismiss() } label: { Image(systemName: "xmark").font(.system(size: 17, weight: .semibold)) }
          .buttonStyle(MapControlButtonStyle()).padding(12).accessibilityLabel("Close map").accessibilityIdentifier("close-place-map")
      }
  }
  private var itinerary: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        Text("\(places.count) places").font(.subheadline)
        Text(block.title ?? "Your places").font(.title3.weight(.semibold))
        if let route = block.route {
          Text("\(modeName(route)) · \(Measurement(value: route.distanceMeters, unit: UnitLength.meters).formatted(.measurement(width: .abbreviated, usage: .road))) · \(travelTime(route.durationSeconds))")
            .font(.subheadline).foregroundStyle(.secondary)
        }
        Divider()
        ForEach(Array(places.enumerated()), id: \.element.id) { index, place in
          VStack(alignment: .leading, spacing: 12) {
            if block.route != nil { Text(index == 0 ? "Start here" : index == places.count - 1 ? "Destination" : "Stop \(index + 1)").font(.subheadline).foregroundStyle(.secondary) }
            Button { selected = place.id } label: { HStack(spacing: 12) { PlaceThumbnail(source: place.imageUrl, name: place.name); PlaceDetails(place: place) } }.buttonStyle(.plain)
            if let notes = place.notes { Text(notes).font(.subheadline).foregroundStyle(.secondary) }
            if let address = place.address { Text(address).font(.caption).foregroundStyle(.secondary) }
            if let source = presentationURL(place.sourceUrl) { Link(place.provider ?? "Source", destination: source).font(.caption) }
            if let route = block.route, index < route.legs.count {
              HStack { Rectangle().frame(height: 0.5); Text("\(modeName(route)) ~\(travelTime(route.legs[index].durationSeconds))").fixedSize(); Rectangle().frame(height: 0.5) }.font(.caption).foregroundStyle(.secondary).padding(.vertical, 8)
            }
          }
        }
        if let attribution = block.route?.attribution { Text(attribution).font(.caption2).foregroundStyle(.secondary) }
      }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
    }.background(NativePalette.background).accessibilityIdentifier("place-itinerary")
  }
}
private struct PlaceDetailSheet: View {
  let place: PresentationPlace
  let onShowMap: () -> Void
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        if let image = presentationURL(place.imageUrl) {
          AsyncImage(url: image) { value in
            if let image = value.image { image.resizable().scaledToFill() }
            else { NativePalette.surface }
          }.frame(height: 210).frame(maxWidth: .infinity).clipped()
        }
        VStack(alignment: .leading, spacing: 16) {
          Text(place.name).font(.title2.weight(.bold)).fixedSize(horizontal: false, vertical: true)
          HStack(spacing: 5) {
            if let rating = place.rating { Image(systemName: "star.fill"); Text(rating, format: .number.precision(.fractionLength(1))) }
            if let category = place.category { Text(category) }
          }.font(.subheadline).foregroundStyle(.secondary)
          HStack(spacing: 10) {
            Button(action: onShowMap) { Label("Show on map", systemImage: "arrow.up.right").font(.subheadline.weight(.medium)).padding(.horizontal, 15).padding(.vertical, 10).background(Color.blue, in: Capsule()).foregroundStyle(.white) }.buttonStyle(.plain).accessibilityIdentifier("place-detail-show-map")
            if let website = presentationURL(place.websiteUrl) { Link("Website", destination: website).font(.subheadline).padding(.horizontal, 15).padding(.vertical, 10).background(NativePalette.surface, in: Capsule()) }
          }
          if let description = place.description { Text(description).font(.subheadline).fixedSize(horizontal: false, vertical: true) }
          if let open = place.isOpen { Text(open ? "Open" : "Closed").foregroundStyle(open ? Color.green : Color.red).font(.subheadline) }
          if let hours = place.hours { Text(hours).font(.subheadline).foregroundStyle(.secondary) }
          if let address = place.address { Divider(); Label(address, systemImage: "mappin.circle").font(.subheadline).fixedSize(horizontal: false, vertical: true) }
          if let notes = place.notes { Text(notes).font(.subheadline).foregroundStyle(.secondary) }
          if let source = presentationURL(place.sourceUrl) { Link(place.provider ?? "Source", destination: source).font(.caption) }
        }.padding(.horizontal, 22).padding(.bottom, 28).padding(.top, place.imageUrl == nil ? 36 : 0)
      }.frame(maxWidth: .infinity, alignment: .leading)
    }.background(NativePalette.background).accessibilityIdentifier("place-details").overlay(alignment: .topTrailing) {
      Button { dismiss() } label: { Image(systemName: "xmark").font(.system(size: 16, weight: .semibold)) }.buttonStyle(MapControlButtonStyle()).padding(12).accessibilityLabel("Close place details").accessibilityIdentifier("close-place-details")
    }
  }
}
private struct PresentationMediaView: View {
  let block: PresentationMedia
  let places: [PresentationPlace]
  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      if let title = block.title { Text(title).font(.headline) }
      ForEach(Array(block.items.enumerated()), id: \.element.id) { index, item in
        if index > 0 { Divider() }
        HStack(alignment: .top, spacing: 12) {
          PlaceThumbnail(source: item.imageUrl ?? places.first(where: { $0.id == item.placeId })?.imageUrl, name: item.title, size: 88)
          VStack(alignment: .leading, spacing: 7) {
            if let link = presentationURL(item.href) { Link("\(index + 1). \(item.title)", destination: link).foregroundStyle(NativePalette.text).font(.body.weight(.semibold)).fixedSize(horizontal: false, vertical: true) }
            else { Text("\(index + 1). \(item.title)").font(.body.weight(.semibold)).fixedSize(horizontal: false, vertical: true) }
            if let description = item.description { Text(description).font(.system(size: 15)).lineSpacing(3).fixedSize(horizontal: false, vertical: true) }
            if let source = presentationURL(item.sourceUrl) { Link(item.sourceLabel ?? "Source", destination: source).font(.caption) }
          }.frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
  }
}
