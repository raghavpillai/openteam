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
  let channelID: String
  var body: some View {
    if store.historyLoadFailures.contains(channelID), store.hasCachedHistory(channelID) {
      HStack(spacing: 12) {
        Text("Couldn't refresh — showing the last loaded messages.")
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("message-refresh-error")
        Spacer(minLength: 0)
        Button("Retry") { Task { await store.loadHistory(channelID) } }
          .disabled(store.busy.contains("history-" + channelID))
          .accessibilityIdentifier("retry-message-refresh")
      }.font(.footnote).foregroundStyle(NativePalette.muted)
        .padding(.horizontal, 16).padding(.vertical, 10).nativeChatGlass()
        .padding(.bottom, 8)
    }
  }
}
