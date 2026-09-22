import SwiftUI

/// Shared app colors. Solid surfaces come from the supplied Grok Bot captures;
/// native materials and semantic status colors still adapt to system accessibility.
enum NativePalette {
  static func color(_ light: String, _ dark: String) -> Color {
    Color(
      uiColor: UIColor { traits in
        let value = UInt64((traits.userInterfaceStyle == .dark ? dark : light), radix: 16) ?? 0
        return UIColor(
          red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255,
          blue: CGFloat(value & 255) / 255, alpha: 1)
      })
  }
  static let background = color("FCFCFC", "141414")
  static let surface = color("F2F2F2", "202020")
  static let text = color("000000", "FFFFFF")
  static let onPrimary = color("FFFFFF", "000000")
  static let muted = color("8E8E8E", "8E8E93")
  static let faint = color("BFBFBF", "666666")
  // Chat labels are translucent in the reference, so their color follows the
  // glass beneath them rather than staying the same grey on every surface.
  static let chatMuted = chatLabel(alpha: 0.6, light: "8E8E8E")
  static let chatFaint = chatLabel(alpha: 0.3, light: "BFBFBF")
  // The input caret stays blue even with the app's monochrome chrome accent.
  // Dark value sampled across idle typing frames in the supplied recording.
  static let chatInsertion = color("016CEC", "395FF1")
  private static func chatLabel(alpha: CGFloat, light: String) -> Color {
    Color(
      uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
          ? UIColor(red: 235 / 255, green: 235 / 255, blue: 245 / 255, alpha: alpha)
          : UIColor(color(light, light))
      })
  }
  static let assistant = surface
  static let user = color("0E0E0E", "545454")
  static let separator = color("E4E4E4", "343434")
  static let code = color("E5E5E5", "2C2C2C")
  static let selection = code
  // Reference action fill: RGB 1/108/236. iOS 26's default blue is brighter.
  static let link = color("016CEC", "016CEC")
  static let disabledPrimary = color("848484", "9A9A9A")
  static let toggle = Color(uiColor: .systemGreen)
  static let receiptCheck = color("347D5B", "559978")
  static let widgetDanger = color("C83A3A", "F48182")
  static let widgetDisabled = color("E4E4E7", "303033")
  static let destructive = Color(uiColor: .systemRed)
  static let warning = Color(uiColor: .systemOrange)

  /// Send the same resolved colors to the offline document renderer. A WebView
  /// cannot inherit SwiftUI's foreground style, including a light user bubble.
  static func documentColors(dark: Bool) -> [String: String] {
    let traits = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
    func css(_ color: Color) -> String {
      var r: CGFloat = 0
      var g: CGFloat = 0
      var b: CGFloat = 0
      var a: CGFloat = 0
      UIColor(color).resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
      return String(
        format: "#%02X%02X%02X", Int((r * 255).rounded()),
        Int((g * 255).rounded()), Int((b * 255).rounded()))
    }
    return [
      "text": css(text), "muted": css(muted), "separator": css(separator),
      "code": css(code), "link": css(link),
      "list-marker": dark ? "rgba(235,235,245,0.3)" : "rgba(60,60,67,0.34)",
    ]
  }
}

/// Use one palette for custom sheets and native grouped settings, rather than
/// silently reverting to UIKit's different grouped backgrounds on deeper pages.
struct NativeForm<Content: View>: View {
  var rowInsets: EdgeInsets? = nil
  @ViewBuilder var content: Content
  var body: some View {
    Form {
      content.listRowBackground(NativePalette.surface)
        .listRowInsets(rowInsets)
        .listRowSeparatorTint(NativePalette.separator)
    }.scrollContentBackground(.hidden).nativeCanvas()
  }
}

struct NativeList<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    List {
      content.listRowBackground(NativePalette.surface)
        .listRowSeparatorTint(NativePalette.separator)
    }.scrollContentBackground(.hidden).nativeCanvas()
  }
}

struct NativeGlass: ViewModifier {
  @Environment(\.colorScheme) private var scheme
  var radius: CGFloat = 22
  var darkTint: Double = 0.11
  func body(content: Content) -> some View {
    // Regular glass diffuses the scrolling backdrop. Match the measured dark
    // resting fill over #141414, but let iOS draw its adaptive rim;
    // an extra white outline makes dark controls look flat and too bright.
    if #available(iOS 26, *) {
      content.glassEffect(
        (scheme == .dark
          ? Glass.regular.tint(.white.opacity(darkTint))
          : Glass.regular.tint(.black.opacity(0.025))).interactive(),
        in: RoundedRectangle(cornerRadius: radius)
      ).overlay {
        if scheme == .light {
          RoundedRectangle(cornerRadius: radius)
            .strokeBorder(.black.opacity(0.12), lineWidth: 0.5)
            .allowsHitTesting(false)
        }
      }
    } else {
      content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius))
        .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
    }
  }
}

/// A neutral tint keeps clear glass from whitening bright messages behind it.
/// Calibrated against both empty-canvas and scrolling-content reference frames;
/// tint alpha is not the opacity of the material itself.
/// The light tint preserves black-label contrast without the regular material's
/// opaque frosting as a dark user bubble passes behind the header.
struct NativeChatGlass: ViewModifier {
  @Environment(\.colorScheme) private var scheme
  var radius: CGFloat = 22
  var regularInLightMode = false
  func body(content: Content) -> some View {
    if scheme == .light && regularInLightMode {
      content.modifier(NativeGlass(radius: radius))
    } else if #available(iOS 26, *) {
      content.glassEffect(
        (scheme == .dark
          ? Glass.clear.tint(Color(white: 55 / 255).opacity(0.5))
          : Glass.clear.tint(Color(white: 239 / 255).opacity(0.25))).interactive(),
        in: RoundedRectangle(cornerRadius: radius)
      ).overlay {
        if scheme == .light {
          RoundedRectangle(cornerRadius: radius)
            .strokeBorder(.black.opacity(0.12), lineWidth: 0.5).allowsHitTesting(false)
        }
      }.shadow(color: scheme == .light ? .black.opacity(0.06) : .clear, radius: 12, y: 3)
    } else {
      content.modifier(NativeGlass(radius: radius))
    }
  }
}

/// The original chat fades the canvas behind the floating controls. Keeping this
/// separate from the glass avoids changing material opacity as history scrolls.
private struct ChatChromeFade: View {
  var edge: VerticalEdge
  var body: some View {
    LinearGradient(
      stops: [
        .init(color: NativePalette.background, location: 0),
        .init(
          color: NativePalette.background.opacity(edge == .top ? 0.85 : 0.9),
          location: edge == .top ? 0.20 : 0.18),
        .init(
          color: NativePalette.background.opacity(
            edge == .top ? 0.48 : 0.35),
          location: edge == .top ? 0.55 : 0.65),
        // Both themes fade before the floating header, independently of its glass.
        .init(
          color: NativePalette.background.opacity(edge == .top ? 0.04 : 0),
          location: edge == .top ? 0.85 : 1),
        .init(color: NativePalette.background.opacity(0), location: 1),
      ],
      startPoint: edge == .top ? .top : .bottom,
      endPoint: edge == .top ? .bottom : .top
    ).allowsHitTesting(false).accessibilityHidden(true)
  }
}

private struct ChatFloatingBars<Top: View, Bottom: View>: ViewModifier {
  var top: Top
  var bottom: Bottom
  func body(content: Content) -> some View {
    GeometryReader { viewport in
      if #available(iOS 26, *) {
        content
          .overlay(alignment: .top) {
            ChatChromeFade(edge: .top)
              .frame(height: viewport.safeAreaInsets.top + 104)
              // The chat header is 44 points with six points above and below.
              .offset(y: -viewport.safeAreaInsets.top - 56)
          }
          .safeAreaBar(edge: .top, spacing: 0) {
            top
          }
          // The composer needs a stable native inset while becoming first
          // responder. The iOS 26 scroll-pocket bar can relinquish its editor
          // during the first keyboard transition.
          .safeAreaInset(edge: .bottom, spacing: 0) {
            bottom.background(alignment: .bottom) {
              // Fade the transcript before it passes under the composer.
              // Sizing this to the short bar leaves bright scrolling glyphs
              // behind the glass; the reference fade begins above the bar.
              GeometryReader { composer in
                ChatChromeFade(edge: .bottom)
                  .frame(width: composer.size.width, height: max(100, composer.size.height + 56))
                  .background(alignment: .bottom) {
                    // Continue the opaque endpoint through the home-indicator
                    // area so content cannot reappear below the gradient.
                    NativePalette.background
                      .frame(height: viewport.safeAreaInsets.bottom)
                      .offset(y: viewport.safeAreaInsets.bottom)
                  }
                  .frame(width: composer.size.width, height: composer.size.height, alignment: .bottom)
                  .offset(y: min(24, viewport.safeAreaInsets.bottom))
              }.allowsHitTesting(false)
            }
          }
          .scrollEdgeEffectHidden()
      } else {
        content.safeAreaInset(edge: .top, spacing: 0) { top }
          .safeAreaInset(edge: .bottom, spacing: 0) { bottom }
      }
    }
  }
}
extension View {
  func nativeChatGlass(radius: CGFloat = 22, regularInLightMode: Bool = false) -> some View {
    modifier(NativeChatGlass(radius: radius, regularInLightMode: regularInLightMode))
  }
  func chatFloatingBars<Top: View, Bottom: View>(
    @ViewBuilder top: () -> Top, @ViewBuilder bottom: () -> Bottom
  ) -> some View {
    modifier(ChatFloatingBars(top: top(), bottom: bottom()))
  }
  func dismissKeyboardOnTap() -> some View {
    simultaneousGesture(
      TapGesture().onEnded {
        UIApplication.shared.sendAction(
          #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
      })
  }
  /// Extend only the page color under the keyboard's transparent rounded corners.
  /// Content continues to avoid the keyboard, keeping fields and controls reachable.
  func nativeCanvas() -> some View {
    background { NativePalette.background.ignoresSafeArea() }
  }

  func nativeGlass(radius: CGFloat = 22, darkTint: Double = 0.11) -> some View {
    modifier(NativeGlass(radius: radius, darkTint: darkTint))
  }
  @ViewBuilder
  func floatingBar<Content: View>(
    edge: VerticalEdge, @ViewBuilder content: () -> Content
  ) -> some View {
    if #available(iOS 26, *) {
      // Register custom controls with the system scroll edge. This supplies the
      // native soft fade without a full-width painted background or gradient.
      safeAreaBar(edge: edge, spacing: 0, content: content)
        .scrollEdgeEffectStyle(.soft, for: edge == .top ? .top : .bottom)
    } else {
      safeAreaInset(edge: edge, spacing: 0, content: content)
    }
  }
  func referenceSheet() -> some View {
    presentationDetents([.fraction(0.95), .large]).presentationDragIndicator(.hidden)
      .presentationCornerRadius(34).presentationBackground(NativePalette.background)
  }
}

struct ChromeButton: View {
  var title: String
  var symbol: String
  var darkTint: Double = 0.11
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: symbol == "xmark" ? 18 : 21, weight: .regular))
        .frame(width: 44, height: 44).foregroundStyle(NativePalette.text).nativeGlass(
          darkTint: darkTint
        )
        .contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityLabel(title)
  }
}

struct ChatChromeButton: View {
  var title: String
  var symbol: String
  var symbolSize: CGFloat = 16
  var symbolWeight: Font.Weight = .semibold
  var regularInLightMode = false
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: symbolSize, weight: symbolWeight))
        .frame(width: 44, height: 44).foregroundStyle(NativePalette.text)
        .nativeChatGlass(regularInLightMode: regularInLightMode).contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityLabel(title)
  }
}
struct AccountMark: View {
  var name: String
  var size: CGFloat = 38
  var initials: String {
    String(name.split(separator: " ").prefix(2).compactMap(\.first)).uppercased()
  }
  var body: some View {
    Text(initials.isEmpty ? "OT" : initials).font(.system(size: size * 0.35, weight: .medium))
      .foregroundStyle(NativePalette.muted).frame(width: size, height: size)
      .background(NativePalette.muted.opacity(0.13), in: Circle())
  }
}
struct SheetHeading: View {
  var title = ""
  var close: () -> Void
  var body: some View {
    HStack(spacing: 14) {
      ChromeButton(title: "Close", symbol: "xmark", action: close).accessibilityIdentifier(
        "sheet-close")
      if !title.isEmpty {
        Text(title).font(.body.weight(.medium)).accessibilityAddTraits(.isHeader)
      }
      Spacer()
    }.padding(.horizontal, 16).padding(.vertical, 16)
  }
}
struct PrimaryActionStyle: ButtonStyle {
  @Environment(\.isEnabled) private var enabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(.body.weight(.medium)).foregroundStyle(NativePalette.onPrimary)
      .frame(maxWidth: .infinity).padding(.vertical, 12)
      .background(enabled ? NativePalette.text : NativePalette.disabledPrimary, in: Capsule())
      .opacity(configuration.isPressed ? 0.75 : 1)
  }
}

/// Restores UIKit's interactive navigation transition when our compact chrome replaces the bar.
struct NativeBackGesture: UIViewControllerRepresentable {
  var shouldBegin: () -> Bool = { true }
  final class Controller: UIViewController, UIGestureRecognizerDelegate {
    var shouldBegin: () -> Bool = { true }
    @MainActor private final class SavedGesture {
      weak var gesture: UIGestureRecognizer?
      weak var delegate: (any UIGestureRecognizerDelegate)?
      let enabled: Bool
      init(_ gesture: UIGestureRecognizer) {
        self.gesture = gesture
        delegate = gesture.delegate
        enabled = gesture.isEnabled
      }
    }
    private var saved: [SavedGesture] = []
    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      guard let navigationController else { return }
      for gesture in NavigationBackPriority.gestures(in: navigationController)
      where gesture.delegate !== self {
        saved.append(SavedGesture(gesture))
        gesture.delegate = self
        gesture.isEnabled = true
      }
    }
    override func viewDidDisappear(_ animated: Bool) {
      super.viewDidDisappear(animated)
      restore()
    }
    func restore() {
      for state in saved {
        guard let gesture = state.gesture, gesture.delegate === self else { continue }
        gesture.delegate = state.delegate
        gesture.isEnabled = state.enabled
      }
      saved.removeAll()
    }
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
      guard let navigationController, navigationController.viewControllers.count > 1,
        navigationController.transitionCoordinator == nil
      else { return false }
      guard shouldBegin() else { return false }
      // Resign the outgoing page's editor before UIKit begins the interactive
      // pop. Keeping its keyboard attached across nested SwiftUI destinations
      // can leave the returning page with a stale zero keyboard inset.
      navigationController.view.endEditing(true)
      return true
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch)
      -> Bool
    {
      guard let navigationController, navigationController.viewControllers.count > 1 else {
        return false
      }
      // iOS 26 supplies a native content-pop recognizer. Limit it to our edge strip
      // so the transition stays interactive and interior message swipes still reply.
      return NavigationBackPriority.contains(touch, in: navigationController)
    }
    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer,
      shouldRequireFailureOf otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
      guard let navigationController else { return false }
      return gestureRecognizer !== navigationController.interactivePopGestureRecognizer
        && otherGestureRecognizer === navigationController.interactivePopGestureRecognizer
    }
    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer,
      shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
      // Give navigation priority over message pans, long presses and attachment
      // taps. Keep the native edge/content recognizers' own ordering acyclic.
      guard let navigationController else { return false }
      return !NavigationBackPriority.gestures(in: navigationController).contains {
        $0 === otherGestureRecognizer
      }
    }
  }
  func makeUIViewController(context: Context) -> Controller { Controller() }
  func updateUIViewController(_ controller: Controller, context: Context) {
    controller.shouldBegin = shouldBegin
  }
  static func dismantleUIViewController(_ controller: Controller, coordinator: ()) {
    controller.restore()
  }
}
