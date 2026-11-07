import SwiftUI
import UIKit

/// Lives inside the message's content bounds, excluding the row's spacers and
/// timestamp. UIKit triggers the flash only after the jump has finished layout.
struct MessageJumpFlash: UIViewRepresentable {
  let messageID: String
  let isUser: Bool

  func makeUIView(context: Context) -> MessageJumpFlashView {
    let view = MessageJumpFlashView()
    view.isUserInteractionEnabled = false
    view.accessibilityElementsHidden = true
    view.layer.cornerRadius = 24
    return view
  }
  func updateUIView(_ view: MessageJumpFlashView, context: Context) {
    if view.messageID != messageID { view.stop() }
    view.messageID = messageID
    // A silver sheen keeps sent text legible on either outgoing bubble color;
    // a light blue wash distinguishes received text from its neutral surface.
    view.backgroundColor = isUser
      ? UIColor.white.withAlphaComponent(0.24)
      : UIColor.systemBlue.withAlphaComponent(0.20)
  }
}

final class MessageJumpFlashView: UIView {
  static let duration: TimeInterval = 0.65
  var messageID = ""

  override init(frame: CGRect) {
    super.init(frame: frame)
    layer.opacity = 0
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func flash() {
    stop()
    let pulse = CAKeyframeAnimation(keyPath: "opacity")
    pulse.values = [0, 1, 1, 0]
    pulse.keyTimes = [0, 0.18, 0.30, 1]
    pulse.duration = Self.duration
    pulse.timingFunctions = [CAMediaTimingFunction(name: .easeOut),
      CAMediaTimingFunction(name: .linear), CAMediaTimingFunction(name: .easeOut)]
    // One opacity pulse, with no movement, scaling, outline or persistent tint.
    layer.add(pulse, forKey: "message-jump")
  }
  func stop() {
    layer.removeAnimation(forKey: "message-jump")
    layer.opacity = 0
  }
}
