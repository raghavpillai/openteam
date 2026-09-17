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
  static let user = color("0A0A0A", "5C5C5C")
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
    }.scrollContentBackground(.hidden).background(NativePalette.background)
  }
}

struct NativeList<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    List {
      content.listRowBackground(NativePalette.surface)
        .listRowSeparatorTint(NativePalette.separator)
    }.scrollContentBackground(.hidden).background(NativePalette.background)
  }
}

struct NativeGlass: ViewModifier {
  @Environment(\.colorScheme) private var scheme
  var radius: CGFloat = 22
  func body(content: Content) -> some View {
    // Glass owns each control's backdrop and shadow. Keep the surrounding header
    // and composer clear so scrolling content remains visible between controls.
    // A faint neutral tint keeps light glass close to the reference's silver edge;
    // white tint washes it out. Measured dark reference interiors are ~52/255
    // over #141414, ~32/255 over black, and ~51/255 in the composer. Preserve
    // clear glass's backdrop response rather than drawing a uniform gray fill.
    if #available(iOS 26, *) {
      content.glassEffect(
        (scheme == .dark
          ? Glass.clear.tint(.white.opacity(0.056))
          : Glass.regular.tint(.black.opacity(0.025))).interactive(),
        in: RoundedRectangle(cornerRadius: radius)
      ).overlay {
        RoundedRectangle(cornerRadius: radius)
          .strokeBorder(
            scheme == .dark ? .white.opacity(0.17) : .black.opacity(0.12), lineWidth: 0.5
          )
          .allowsHitTesting(false)
      }
    } else {
      content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius))
        .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
    }
  }
}
extension View {
  func nativeGlass(radius: CGFloat = 22) -> some View { modifier(NativeGlass(radius: radius)) }
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
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: 21, weight: .regular))
        .frame(width: 44, height: 44).foregroundStyle(NativePalette.text).nativeGlass()
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
  final class Controller: UIViewController {
    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      navigationController?.interactivePopGestureRecognizer?.isEnabled = true
      navigationController?.interactivePopGestureRecognizer?.delegate = nil
    }
  }
  func makeUIViewController(context: Context) -> Controller { Controller() }
  func updateUIViewController(_ controller: Controller, context: Context) {}
}
