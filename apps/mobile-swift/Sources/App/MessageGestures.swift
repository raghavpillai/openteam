import SwiftUI
import UIKit

/// Native recognizers include attachments and WebKit content without covering
/// their controls with an overlay. A quick tap still opens the attachment/link.
struct MessageReplyGesture: UIGestureRecognizerRepresentable {
  var allowsLeftward = false
  var onChanged: (CGSize) -> Void
  var onEnded: (CGSize, CGFloat, Bool) -> Void

  func makeCoordinator(converter: CoordinateSpaceConverter) -> MessageGestureDelegate {
    MessageGestureDelegate(allowsLeftward: allowsLeftward)
  }
  func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
    let recognizer = UIPanGestureRecognizer()
    recognizer.maximumNumberOfTouches = 1
    recognizer.delegate = context.coordinator
    return recognizer
  }
  func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
    // Measure against the window: the message itself moves with the gesture.
    let point = recognizer.translation(in: recognizer.view?.window)
    let translation = CGSize(width: point.x, height: point.y)
    switch recognizer.state {
    case .began, .changed: onChanged(translation)
    case .ended: onEnded(translation, recognizer.velocity(in: recognizer.view?.window).x, false)
    case .cancelled, .failed: onEnded(.zero, 0, true)
    default: break
    }
  }
}

@MainActor final class MessageGestureDelegate: NSObject, UIGestureRecognizerDelegate {
  let allowsLeftward: Bool
  init(allowsLeftward: Bool) { self.allowsLeftward = allowsLeftward }
  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
    let velocity = pan.velocity(in: pan.view?.window)
    // Fail immediately for scrolling or a leftward gesture, so the conversation
    // scroll view and interactive content can handle those touches normally.
    return (allowsLeftward || velocity.x > 0) && abs(velocity.x) > abs(velocity.y) * 1.5
  }
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch)
    -> Bool
  {
    // Reserve the initial edge touch for navigation for this entire touch sequence.
    // In particular, a canceled back transition must never fall through to Reply.
    if let navigation = NavigationBackPriority.navigation(from: gestureRecognizer.view),
      NavigationBackPriority.contains(touch, in: navigation) { return false }
    var view = touch.view
    while let current = view {
      // Preserve native editing/selection in embedded message forms.
      if current is UIControl || current is UITextView { return false }
      view = current.superview
    }
    return true
  }
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRequireFailureOf otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    guard let navigation = NavigationBackPriority.navigation(from: gestureRecognizer.view) else { return false }
    return NavigationBackPriority.gestures(in: navigation).contains { $0 === otherGestureRecognizer }
  }
}

@MainActor enum NavigationBackPriority {
  static func gestures(in navigation: UINavigationController) -> [UIGestureRecognizer] {
    var result = [navigation.interactivePopGestureRecognizer].compactMap { $0 }
    if #available(iOS 26, *), let content = navigation.interactiveContentPopGestureRecognizer {
      result.append(content)
    }
    return result
  }
  static func contains(_ touch: UITouch, in navigation: UINavigationController) -> Bool {
    guard let view = navigation.viewIfLoaded else { return false }
    let point = touch.location(in: view)
    let distance = view.effectiveUserInterfaceLayoutDirection == .rightToLeft
      ? view.bounds.maxX - point.x : point.x - view.bounds.minX
    // Older systems expose only the narrower native screen-edge recognizer.
    let width: CGFloat = gestures(in: navigation).count > 1 ? 32 : 16
    return distance >= 0 && distance <= width
  }
  static func navigation(from view: UIView?) -> UINavigationController? {
    var responder: UIResponder? = view
    while let current = responder {
      if let controller = current as? UIViewController,
        let navigation = controller.navigationController,
        navigation.viewControllers.count > 1,
        navigation.interactivePopGestureRecognizer?.isEnabled == true { return navigation }
      responder = current.next
    }
    return nil
  }
}
