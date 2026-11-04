import SwiftUI

/// Sidebar dimensions measured from the supplied 3× reference captures.
enum SidebarMetrics {
  static let width: CGFloat = 280
  static let leading: CGFloat = 20
  static let trailing: CGFloat = 13
  static let accountSize: CGFloat = 32
  static let accountGap: CGFloat = 10
  static let accountFont: CGFloat = 18
  static let pluginSize: CGFloat = 16
  static let pluginOverlap: CGFloat = 4
  static let pluginPadding: CGFloat = 13
  static let capsuleHeight: CGFloat = 38
  static let rowHeight: CGFloat = 86
  static let searchGlyph: CGFloat = 18
  static let addGlyph: CGFloat = 16
  static let toolbarTrailing: CGFloat = 19
  static let toolbarTop: CGFloat = 2
  static let footerBottom: CGFloat = 18
  static let unreadBottom: CGFloat = 76
}

/// The same unread affordance is used on the full inbox and the persistent sidebar.
struct UnreadPill: View {
  let count: Int
  var isSidebar = false
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 7) {
        if isSidebar {
          Text("\(count) unread").font(.system(size: 15))
        } else {
          Text("\(count) unread").monospacedDigit()
        }
        Image(systemName: "chevron.down").font(.system(size: isSidebar ? 14 : 13, weight: isSidebar ? .medium : .semibold))
      }.font(.system(size: 16)).foregroundStyle(.white)
        .padding(.horizontal, isSidebar ? 12 : 14).frame(height: isSidebar ? SidebarMetrics.capsuleHeight : 36)
        .modifier(UnreadGlass()).frame(minHeight: 44)
    }.buttonStyle(.plain).accessibilityLabel("\(count) unread " + (count == 1 ? "conversation" : "conversations"))
      .accessibilityHint("Scroll to the next unread conversation")
  }
}

struct MarketplaceShortcut: View {
  @Environment(AppStore.self) private var store
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var compact = false
  var revision = 0
  var expandedWidth: CGFloat?
  var onExpansionChange: (Bool) -> Void = { _ in }
  var action: () -> Void
  @State private var hovered = false
  @State private var installed: [JSON] = []
  @State private var catalog: [JSON] = []
  private func key(_ plugin: JSON) -> String {
    plugin["pluginKey"].string.isEmpty ? plugin["key"].string : plugin["pluginKey"].string
  }
  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        if compact && hovered {
          Text("Connect apps").font(.system(size: 15)).lineLimit(1)
            .transition(.opacity.combined(with: .scale(scale: 0.94)))
        }
        HStack(spacing: compact ? -SidebarMetrics.pluginOverlap : 0) {
          if compact {
            ForEach(Array(installed.prefix(3).enumerated()), id: \.offset) { _, plugin in
              PluginCatalogMark(
                plugin: plugin, fallback: catalog.first { key($0) == key(plugin) },
                size: SidebarMetrics.pluginSize
              )
              .overlay {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                  .stroke(.black.opacity(0.42), lineWidth: 0.5)
              }
              .shadow(color: .black.opacity(0.22), radius: 0.5, x: -0.3, y: 0)
              .accessibilityHidden(true)
            }
          }
          if compact && !hovered {
            Image(systemName: "plus").font(.system(size: 10, weight: .regular))
              .foregroundStyle(Color(white: 0.55)).frame(
                width: SidebarMetrics.pluginSize, height: SidebarMetrics.pluginSize
              )
              .background(.white.opacity(0.97), in: RoundedRectangle(cornerRadius: 4))
              .overlay(
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                  .stroke(.black.opacity(0.42), lineWidth: 0.5)
              )
              .accessibilityHidden(true)
          } else if !compact {
            MarketplaceMark().frame(width: 23, height: 23)
          }
        }
      }.padding(.horizontal, compact ? SidebarMetrics.pluginPadding : 0)
        .frame(minWidth: 44, minHeight: compact ? SidebarMetrics.capsuleHeight : 44)
        .frame(width: compact && hovered ? expandedWidth : nil)
        .modifier(MarketplaceGlass(compact: compact))
        .frame(height: 44).contentShape(Rectangle())
    }.buttonStyle(.plain)
      .onHover { inside in
        guard compact, expandedWidth != nil else { return }
        withAnimation(reduceMotion ? nil : .spring(response: 0.48, dampingFraction: 0.82)) {
          hovered = inside
          onExpansionChange(inside)
        }
      }
      .accessibilityElement(children: .ignore).accessibilityAddTraits(.isButton).accessibilityLabel(
        "Marketplace"
      )
      .accessibilityIdentifier("marketplace-button")
      .accessibilityValue(
        compact
          ? "\(installed.count) installed " + (installed.count == 1 ? "plugin" : "plugins") : ""
      )
      .task(id: revision) {
        guard compact, let value = try? await store.request("/api/v0/plugins") else { return }
        catalog = value["catalog"].array
        installed = value["installs"].array
      }
  }
}

/// The expanded sidebar uses the reference's smaller account disc; it has no outer glass button.
struct SidebarAccountMark: View {
  var name: String
  private var initials: String {
    String(name.split(separator: " ").prefix(2).compactMap(\.first)).uppercased()
  }
  var body: some View {
    Text(initials.isEmpty ? "OT" : initials).font(.system(size: 13, weight: .semibold))
      .foregroundStyle(NativePalette.muted).frame(width: SidebarMetrics.accountSize, height: SidebarMetrics.accountSize)
      .background(NativePalette.color("E5E5E8", "2D2C31").opacity(0.75), in: Circle())
      .background(.ultraThinMaterial, in: Circle())
      .accessibilityHidden(true)
  }
}

/// Keep the sidebar's shallow capsule independent of the 44-point Duo rail controls.
private struct MarketplaceGlass: ViewModifier {
  @Environment(\.colorScheme) private var scheme
  var compact: Bool
  @ViewBuilder func body(content: Content) -> some View {
    if compact {
      // A fixed neutral fill and rim keep this small capsule consistent across
      // iOS versions; system glass adds a much brighter outline on iOS 27.
      content
        .background(NativePalette.color("FFFFFF", "3B3B3B"), in: Capsule())
        .overlay {
          if scheme == .light {
            Capsule().strokeBorder(.black.opacity(0.14), lineWidth: 0.5).allowsHitTesting(false)
          } else {
            Capsule().strokeBorder(
              LinearGradient(colors: [.white.opacity(0.20), .white.opacity(0.08), .white.opacity(0.10)],
                startPoint: .top, endPoint: .bottom), lineWidth: 0.6).allowsHitTesting(false)
          }
        }
        .shadow(color: .black.opacity(scheme == .light ? 0.035 : 0.12), radius: 8, y: 3)
    } else { content.nativeInboxGlass() }
  }
}

private struct MarketplaceMark: View {
  var body: some View {
    GeometryReader { geometry in
      let side = geometry.size.width * 0.38
      let gap = geometry.size.width * 0.14
      VStack(spacing: gap) {
        HStack(spacing: gap) { tile(side); tile(side) }
        HStack(spacing: gap) {
          tile(side)
          Image(systemName: "plus").font(.system(size: side + 2, weight: .semibold))
            .frame(width: side, height: side)
        }
      }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }.accessibilityHidden(true)
  }
  private func tile(_ side: CGFloat) -> some View {
    RoundedRectangle(cornerRadius: 1.5).strokeBorder(lineWidth: 1.8).frame(width: side, height: side)
  }
}

private struct UnreadGlass: ViewModifier {
  private let tint = Color(red: 0, green: 122 / 255, blue: 1)
  func body(content: Content) -> some View {
    if #available(iOS 26, *) {
      // Keep the blue overlay independent of the system's tint strength, which
      // differs between iOS 26 and 27. The live backdrop still refracts through it.
      content.background(tint.opacity(0.86), in: Capsule())
        .glassEffect(.clear.interactive(), in: Capsule())
        .overlay {
          Capsule().strokeBorder(.white.opacity(0.24), lineWidth: 0.5).allowsHitTesting(false)
        }
    } else {
      content.background(tint.opacity(0.78), in: Capsule())
        .background(.regularMaterial, in: Capsule())
    }
  }
}

/// The footer blurs the live list through a transparent material. Its mask affects
/// the backdrop, leaving the rows available for the glass controls to refract.
struct SidebarFooterFade: View {
  static let canvas = NativePalette.color("F7F7F7", "1E1E1E")
  var body: some View {
    SidebarBackdropBlur()
      .overlay {
        // Settle into the sidebar's exact canvas color. The material alone
        // lifts dark footers to gray, unlike the supplied reference.
        LinearGradient(stops: [
          .init(color: .clear, location: 0),
          .init(color: Self.canvas.opacity(0.75), location: 0.42),
          .init(color: Self.canvas, location: 0.82),
          .init(color: Self.canvas, location: 1),
        ], startPoint: .top, endPoint: .bottom)
      }
      .mask {
        LinearGradient(stops: [
          .init(color: .clear, location: 0),
          .init(color: .black.opacity(0.12), location: 0.22),
          .init(color: .black.opacity(0.65), location: 0.58),
          .init(color: .black, location: 1),
        ], startPoint: .top, endPoint: .bottom)
      }
      .allowsHitTesting(false).accessibilityHidden(true)
  }
}

private struct SidebarBackdropBlur: UIViewRepresentable {
  func makeUIView(context: Context) -> UIVisualEffectView {
    let view = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
    view.isUserInteractionEnabled = false
    return view
  }
  func updateUIView(_ view: UIVisualEffectView, context: Context) {}
}

/// Clear glass preserves the reference's dark charcoal fill and the native rim.
/// Regular glass on Duo brightens these controls beyond the supplied captures.
private struct InboxControlGlass: ViewModifier {
  @Environment(\.colorScheme) private var scheme
  @Environment(\.sideChrome) private var sideChrome
  func body(content: Content) -> some View {
    if sideChrome != nil {
      content.modifier(RailControlGlass())
    } else if #available(iOS 26, *), scheme == .dark {
      content.glassEffect(.clear.tint(Color(white: 0.22).opacity(0.65)).interactive(), in: Capsule())
    } else {
      content.nativeGlass()
    }
  }
}

extension View {
  func nativeInboxGlass() -> some View { modifier(InboxControlGlass()) }
}

struct InboxChromeButton: View {
  var title: String
  var symbol: String
  var pointSize: CGFloat = 21
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      icon
        .foregroundStyle(NativePalette.text).frame(width: 44, height: 44)
        .nativeInboxGlass().contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityLabel(title)
  }
  @ViewBuilder private var icon: some View {
    if symbol == "sidebar.left" {
      ZStack(alignment: .leading) {
        RoundedRectangle(cornerRadius: 1.5).strokeBorder(lineWidth: 1.8)
        Rectangle().frame(width: 6)
      }.frame(width: 19, height: 15)
        .clipShape(RoundedRectangle(cornerRadius: 1.5))
    } else {
      Image(systemName: symbol).font(.system(size: pointSize))
    }
  }
}
