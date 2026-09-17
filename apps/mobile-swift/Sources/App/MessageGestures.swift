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
    var view = touch.view
    while let current = view {
      // Preserve native editing/selection in embedded message forms.
      if current is UIControl || current is UITextView { return false }
      view = current.superview
    }
    return true
  }
}
