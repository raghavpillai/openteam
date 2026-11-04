import SwiftUI
import UIKit

struct ActionFailureToast: View {
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  let message: String
  var body: some View {
    Label(message, systemImage: "exclamationmark.circle.fill")
      .font(.subheadline.weight(.semibold))
      .foregroundStyle(reduceTransparency ? Color.white : Color.primary)
      .padding(.horizontal, 16).padding(.vertical, 14)
      .modifier(FailureGlass(reduceTransparency: reduceTransparency))
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityAddTraits(.updatesFrequently)
  }
}

/// Anchors above presented sheets without taking keyboard focus or blocking the form.
struct TopFailureBanner: UIViewRepresentable {
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let message: String?

  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeUIView(context: Context) -> Anchor {
    let anchor = Anchor()
    anchor.isUserInteractionEnabled = false
    anchor.windowChanged = { [weak coordinator = context.coordinator] window in
      coordinator?.render(in: window)
    }
    return anchor
  }
  func updateUIView(_ view: Anchor, context: Context) {
    context.coordinator.message = message
    context.coordinator.scheme = scheme
    context.coordinator.reduceMotion = reduceMotion
    context.coordinator.render(in: view.window)
  }
  static func dismantleUIView(_ view: Anchor, coordinator: Coordinator) {
    view.windowChanged = nil
    coordinator.hide(animated: false)
  }

  final class Anchor: UIView {
    var windowChanged: ((UIWindow?) -> Void)?
    override func didMoveToWindow() {
      super.didMoveToWindow()
      windowChanged?(window)
    }
  }

  @MainActor final class Coordinator {
    var message: String?
    var scheme: ColorScheme = .dark
    var reduceMotion = false
    private var hosting: UIHostingController<ActionFailureToast>?

    func render(in window: UIWindow?) {
      guard let window, let message else {
        hide(animated: window != nil)
        return
      }
      if let hosting, hosting.view.window === window {
        hosting.rootView = ActionFailureToast(message: message)
        hosting.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
        window.bringSubviewToFront(hosting.view)
        return
      }
      hide(animated: false)
      let hosting = UIHostingController(rootView: ActionFailureToast(message: message))
      hosting.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
      hosting.sizingOptions = .intrinsicContentSize
      let banner = hosting.view!
      banner.backgroundColor = .clear
      banner.isUserInteractionEnabled = false
      banner.accessibilityIdentifier = "creation-error"
      banner.translatesAutoresizingMaskIntoConstraints = false
      window.addSubview(banner)
      let safe = window.safeAreaLayoutGuide
      let width = banner.widthAnchor.constraint(equalTo: safe.widthAnchor, constant: -32)
      width.priority = .defaultHigh
      NSLayoutConstraint.activate([
        banner.topAnchor.constraint(equalTo: safe.topAnchor, constant: 8),
        banner.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
        banner.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
        width,
      ])
      window.layoutIfNeeded()
      self.hosting = hosting
      UIAccessibility.post(notification: .announcement, argument: message)
      banner.alpha = 0
      if !reduceMotion {
        banner.transform = CGAffineTransform(translationX: 0, y: -banner.frame.maxY - 12)
          .scaledBy(x: 0.96, y: 0.96)
      }
      if reduceMotion {
        UIView.animate(withDuration: 0.2) { banner.alpha = 1 }
      } else {
        UIView.animate(springDuration: 0.55, bounce: 0.18, options: [.allowUserInteraction]) {
          banner.alpha = 1
          banner.transform = .identity
        }
      }
    }

    func hide(animated: Bool) {
      guard let hosting else { return }
      self.hosting = nil
      let banner = hosting.view!
      guard animated else {
        banner.removeFromSuperview()
        return
      }
      UIView.animate(
        withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]
      ) {
        banner.alpha = 0
        if !self.reduceMotion {
          banner.transform = CGAffineTransform(translationX: 0, y: -banner.frame.maxY - 12)
        }
      } completion: { _ in
        hosting.view.removeFromSuperview()
      }
    }
  }
}

private struct FailureGlass: ViewModifier {
  let reduceTransparency: Bool
  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: 18)
    if reduceTransparency {
      content.background(Color(hex: "A92C3B"), in: shape)
    } else if #available(iOS 26, *) {
      content.glassEffect(.clear.tint(Color(hex: "ED4C57").opacity(0.28)), in: shape)
    } else {
      content.background(.ultraThinMaterial, in: shape)
        .background(Color(hex: "ED4C57").opacity(0.18), in: shape)
    }
  }
}

struct MessageRefreshStatus: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  let channelID: String
  var body: some View {
    if store.connectionUnavailable, store.hasCachedHistory(channelID) {
      Group {
        if dynamicTypeSize.isAccessibilitySize {
          VStack(alignment: .leading, spacing: 8) {
            statusLabel
            retryButton
          }
        } else {
          HStack(spacing: 12) {
            statusLabel.frame(maxWidth: .infinity, alignment: .leading)
            retryButton
          }
        }
      }
        .foregroundStyle(NativePalette.text)
        .padding(.leading, 16).padding(.trailing, 12).padding(.vertical, 12)
        .modifier(ConnectionStatusGlass(reduceTransparency: reduceTransparency))
        .padding(.bottom, 8)
    }
  }
  private var statusLabel: some View {
    HStack(alignment: .top, spacing: 10) {
      if !dynamicTypeSize.isAccessibilitySize {
        Image(systemName: "wifi.slash").font(.subheadline.weight(.semibold))
          .padding(.top, 2).accessibilityHidden(true)
      }
      VStack(alignment: .leading, spacing: 4) {
        Text("Can’t connect to server").font(.subheadline.weight(.semibold))
          .accessibilityIdentifier("message-refresh-error")
        Text("Saved messages. Reconnecting…")
          .font(.footnote)
      }.fixedSize(horizontal: false, vertical: true)
    }
  }
  private var retryButton: some View {
    Button { store.retryConnection() } label: {
      ZStack {
        Text("Retry").opacity(store.checkingConnection ? 0 : 1)
        if store.checkingConnection {
          ProgressView().tint(NativePalette.onPrimary)
        }
      }
    }
      .font(.subheadline.weight(.semibold))
      .foregroundStyle(NativePalette.onPrimary)
      .padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 44)
      .background(NativePalette.text, in: Capsule())
      .fixedSize(horizontal: true, vertical: true)
      .disabled(store.checkingConnection)
      .buttonStyle(.plain)
      .accessibilityLabel(store.checkingConnection ? "Retrying connection" : "Retry connection")
      .accessibilityIdentifier("retry-message-refresh")
  }
}

private struct ConnectionStatusGlass: ViewModifier {
  let reduceTransparency: Bool
  func body(content: Content) -> some View {
    if reduceTransparency {
      content.background(NativePalette.surface, in: RoundedRectangle(cornerRadius: 18))
    } else {
      // Regular liquid glass diffuses message glyphs while keeping the native
      // rim and reflections. Clear glass lets scrolling text compete with the label.
      content.modifier(NativeGlass(radius: 18, darkTint: 0.08))
    }
  }
}
