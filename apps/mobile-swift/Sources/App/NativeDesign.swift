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
  static let assistant = surface
  static let user = color("0A0A0A", "545454")
  static let separator = color("E4E4E4", "343434")
  static let code = color("E5E5E5", "2C2C2C")
  static let selection = code
  // Reference action fill: RGB 1/108/236. iOS 26's default blue is brighter.
  static let link = color("016CEC", "016CEC")
  static let disabledPrimary = color("848484", "9A9A9A")
  static let toggle = Color(uiColor: .systemGreen)
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
    ]
  }
}

/// Use one palette for custom sheets and native grouped settings, rather than
/// silently reverting to UIKit's different grouped backgrounds on deeper pages.
struct NativeForm<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    Form {
      content.listRowBackground(NativePalette.surface)
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
extension View {
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
      Image(systemName: symbol).font(.system(size: 21, weight: .regular))
        .frame(width: 44, height: 44).foregroundStyle(NativePalette.text).nativeGlass(
          darkTint: darkTint
        )
        .contentShape(Rectangle())
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
  final class Controller: UIViewController, UIGestureRecognizerDelegate {
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
      // Native navigation recognizers already classify horizontal motion.
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
  func updateUIViewController(_ controller: Controller, context: Context) {}
  static func dismantleUIViewController(_ controller: Controller, coordinator: ()) {
    controller.restore()
  }
}
