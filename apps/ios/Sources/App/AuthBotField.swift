import SwiftUI
import UIKit

/// The original React Native AuthGate composition, measured in window fractions.
/// Its bots rock as whole silhouettes; the face/part animation used in chats stays still here.
struct AuthBotField: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase
  let size: CGSize
  let stage: Int
  private struct Decoration {
    let color: String, kind: String
    let left: CGFloat, top: CGFloat, width: CGFloat, rotation: Double
  }
  private let bots: [Decoration] = [
    .init(color: "08C875", kind: "chip", left: 0.18, top: 0.11, width: 0.205, rotation: -8),
    .init(color: "F72591", kind: "pod", left: 0.57, top: 0.17, width: 0.16, rotation: 18),
    .init(color: "8850F5", kind: "terminal", left: -0.02, top: 0.31, width: 0.14, rotation: 80),
    .init(color: "9D683E", kind: "helmet", left: 0.88, top: 0.31, width: 0.16, rotation: -22),
    .init(color: "FF9912", kind: "helmet", left: -0.09, top: 0.50, width: 0.20, rotation: 15),
    .init(color: "FF2445", kind: "helmet", left: 0.93, top: 0.51, width: 0.20, rotation: -22),
    .init(color: "1685ED", kind: "tv-head", left: 0.03, top: 0.70, width: 0.18, rotation: 4),
    .init(color: "08BCA9", kind: "helmet", left: 0.80, top: 0.70, width: 0.16, rotation: -18),
    .init(color: "FF6811", kind: "hex-visor", left: 0.36, top: 0.76, width: 0.21, rotation: 4),
  ]
  var body: some View {
    ZStack(alignment: .topLeading) {
      ForEach(bots.indices, id: \.self) { index in
        let bot = bots[index]
        let width = size.width * bot.width
        FloatingAuthBot(
          color: UIColor(Color(hex: bot.color)), shape: RobotShape(icon: bot.kind), index: index,
          animated: !reduceMotion && scenePhase == .active
        )
        .frame(width: width, height: width)
        .rotationEffect(.degrees(bot.rotation))
        .scaleEffect(index < 6 ? 1 : stage == 0 ? 1 : stage == 1 ? 0.94 : 0.86)
        .opacity(index < 6 ? 1 : stage == 0 ? 1 : stage == 1 ? 0.92 : 0.72)
        .position(x: size.width * bot.left + width / 2, y: size.height * bot.top + width / 2)
      }
    }.allowsHitTesting(false).accessibilityHidden(true)
  }
}

private struct FloatingAuthBot: UIViewRepresentable {
  let color: UIColor, shape: RobotShape, index: Int, animated: Bool
  func makeUIView(context: Context) -> FloatingAuthBotView { FloatingAuthBotView(shape: shape) }
  func updateUIView(_ view: FloatingAuthBotView, context: Context) {
    view.robot.configure(
      color: color, shape: shape, mode: .still, reduced: true, active: false,
      sampleTime: nil, faceColor: UIColor(Color(hex: "111111")))
    view.setFloating(animated, index: index)
  }
  static func dismantleUIView(_ view: FloatingAuthBotView, coordinator: ()) {
    view.setFloating(false, index: 0)
    view.robot.stop()
  }
}

private final class FloatingAuthBotView: UIView {
  let robot: NativeRobotView
  private var animated = false
  private var index = 0
  init(shape: RobotShape) {
    robot = NativeRobotView(shape: shape)
    super.init(frame: .zero)
    isOpaque = false
    isUserInteractionEnabled = false
    accessibilityElementsHidden = true
    addSubview(robot)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func layoutSubviews() {
    super.layoutSubviews()
    robot.frame = bounds
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    updateAnimation()
  }
  func setFloating(_ value: Bool, index: Int) {
    animated = value
    self.index = index
    updateAnimation()
  }
  private func updateAnimation() {
    guard animated, window != nil else {
      robot.layer.removeAnimation(forKey: "auth-float")
      return
    }
    guard robot.layer.animation(forKey: "auth-float") == nil else { return }
    let direction = index.isMultiple(of: 2) ? 1.0 : -1.0
    let animation = CAKeyframeAnimation(keyPath: "transform")
    animation.values = (0...40).map { frame -> NSValue in
      let progress = (1 - cos(Double(frame) / 40 * .pi)) / 2
      var transform = CATransform3DMakeTranslation(
        progress * direction * 2.5, -progress * (4 + Double(index % 3) * 1.25), 0)
      transform = CATransform3DRotate(transform, progress * direction * 2.2 * .pi / 180, 0, 0, 1)
      transform = CATransform3DScale(transform, 1 + progress * 0.018, 1 + progress * 0.018, 1)
      return NSValue(caTransform3D: transform)
    }
    animation.duration = 1.75 + Double(index % 4) * 0.18
    animation.beginTime = CACurrentMediaTime() + Double(index) * 0.095
    animation.autoreverses = true
    animation.repeatCount = .infinity
    robot.layer.add(animation, forKey: "auth-float")
  }
}
