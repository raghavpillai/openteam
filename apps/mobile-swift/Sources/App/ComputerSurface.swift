import SwiftUI
import UIKit

struct ComputerSurface: UIViewRepresentable {
  let vnc: ComputerVNC
  let remoteSize: CGSize
  let interactive: Bool
  let trackpad: Bool
  let action: ([String: JSON]) -> Void
  func makeUIView(context: Context) -> ComputerSurfaceView { ComputerSurfaceView() }
  func updateUIView(_ view: ComputerSurfaceView, context: Context) {
    view.configure(
      vnc: vnc, remoteSize: remoteSize, interactive: interactive, trackpad: trackpad,
      action: action)
  }
}

@MainActor
final class ComputerSurfaceView: UIView, UIScrollViewDelegate, UIGestureRecognizerDelegate {
  private let scroll = UIScrollView()
  private let picture = UIView()
  private weak var renderer: UIView?
  private var dragging = false
  private let pointer = UIView()
  private var remoteSize = CGSize(width: 1280, height: 800)
  private var controlling = false
  private var trackpad = false
  private var action: ([String: JSON]) -> Void = { _ in }
  private var remotePointer = CGPoint(x: 640, y: 400)
  private var baseSize = CGSize.zero
  private var viewportGesture = false
  private var trackpadStart = CGPoint.zero
  private lazy var pointerGesture = ComputerPointerGesture(
    target: self, action: #selector(pointerChanged(_:)))
  private lazy var twoFingerTap = UITapGestureRecognizer(
    target: self, action: #selector(twoTapped(_:)))
  private lazy var twoFingerPan = UIPanGestureRecognizer(
    target: self, action: #selector(twoPanned(_:)))
  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    clipsToBounds = true
    scroll.delegate = self
    scroll.minimumZoomScale = 1
    scroll.maximumZoomScale = 3
    scroll.bounces = false
    scroll.bouncesZoom = false
    scroll.showsHorizontalScrollIndicator = false
    scroll.showsVerticalScrollIndicator = false
    addSubview(scroll)
    scroll.addSubview(picture)
    picture.isUserInteractionEnabled = true
    pointer.backgroundColor = UIColor.white.withAlphaComponent(0.8)
    pointer.layer.borderColor = UIColor.black.cgColor
    pointer.layer.borderWidth = 2
    pointer.layer.cornerRadius = 7
    pointer.bounds = CGRect(x: 0, y: 0, width: 14, height: 14)
    pointer.isUserInteractionEnabled = false
    picture.addSubview(pointer)
    twoFingerTap.numberOfTouchesRequired = 2
    twoFingerPan.minimumNumberOfTouches = 2
    twoFingerPan.maximumNumberOfTouches = 2
    scroll.panGestureRecognizer.require(toFail: twoFingerPan)
    for recognizer in [pointerGesture, twoFingerTap, twoFingerPan] {
      recognizer.delegate = self
      picture.addGestureRecognizer(recognizer)
    }
    picture.accessibilityIdentifier = "computer-screen"
    picture.isAccessibilityElement = true
    picture.accessibilityLabel = "Live computer screen"
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  func configure(
    vnc: ComputerVNC, remoteSize: CGSize, interactive: Bool, trackpad: Bool,
    action: @escaping ([String: JSON]) -> Void
  ) {
    if renderer !== vnc.webView {
      renderer?.removeFromSuperview()
      renderer = vnc.webView
      picture.insertSubview(vnc.webView, at: 0)
    }
    if controlling && !interactive { releasePointer() }
    vnc.setControl(interactive)
    self.remoteSize = remoteSize
    self.controlling = interactive
    self.trackpad = trackpad
    self.action = action
    scroll.panGestureRecognizer.minimumNumberOfTouches = interactive ? 2 : 1
    for recognizer in [pointerGesture, twoFingerTap, twoFingerPan] {
      if recognizer.isEnabled != interactive { recognizer.isEnabled = interactive }
    }
    pointer.isHidden = !trackpad
    updatePointer()
    setNeedsLayout()
    picture.accessibilityHint =
      interactive
      ? "Tap to click, hold or tap with two fingers to right-click, and use two fingers to scroll. Pinch to zoom, then pan with two fingers. In trackpad mode, tap then drag to drag remotely."
      : "Take control to interact. Pinch to zoom."
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    let changed = scroll.frame.size != bounds.size
    scroll.frame = bounds
    let scale = min(
      bounds.width / max(remoteSize.width, 1), bounds.height / max(remoteSize.height, 1))
    let size = CGSize(width: remoteSize.width * scale, height: remoteSize.height * scale)
    if size != baseSize || changed {
      scroll.zoomScale = 1
      baseSize = size
      picture.frame = CGRect(origin: .zero, size: size)
      scroll.contentSize = size
    }
    renderer?.frame = picture.bounds
    center()
    updatePointer()
  }
  func viewForZooming(in scrollView: UIScrollView) -> UIView? { picture }
  func scrollViewWillBeginZooming(_ scrollView: UIScrollView, with view: UIView?) {
    viewportGesture = true
  }
  func scrollViewDidZoom(_ scrollView: UIScrollView) { center() }
  override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    if gestureRecognizer === twoFingerPan { return controlling && scroll.zoomScale <= 1.01 }
    return controlling
  }
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    // A second finger cancels pointer input and can become a scroll, pinch, or right-click.
    gestureRecognizer === pointerGesture || other === pointerGesture
      || (gestureRecognizer === twoFingerPan && other === scroll.pinchGestureRecognizer)
      || (other === twoFingerPan && gestureRecognizer === scroll.pinchGestureRecognizer)
  }
  private func center() {
    scroll.contentInset = UIEdgeInsets(
      top: max(0, (bounds.height - picture.frame.height) / 2),
      left: max(0, (bounds.width - picture.frame.width) / 2), bottom: 0, right: 0)
  }
  private func point(_ gesture: UIGestureRecognizer) -> CGPoint {
    let p = gesture.location(in: picture)
    return clamp(
      CGPoint(
        x: p.x / max(baseSize.width, 1) * remoteSize.width,
        y: p.y / max(baseSize.height, 1) * remoteSize.height))
  }
  private func clamp(_ p: CGPoint) -> CGPoint {
    CGPoint(
      x: min(max(0, p.x.rounded()), max(0, remoteSize.width - 1)),
      y: min(max(0, p.y.rounded()), max(0, remoteSize.height - 1)))
  }
  private func updatePointer() {
    pointer.center = CGPoint(
      x: remotePointer.x / max(remoteSize.width, 1) * baseSize.width,
      y: remotePointer.y / max(remoteSize.height, 1) * baseSize.height)
  }
  private func click(_ p: CGPoint, double: Bool = false, right: Bool = false) {
    action([
      "action": .string("click"), "x": .number(p.x), "y": .number(p.y), "double": .bool(double),
      "button": .string(right ? "right" : "left"),
    ])
  }
  private func remotePoint(_ point: CGPoint) -> CGPoint {
    clamp(
      CGPoint(
        x: point.x / max(baseSize.width, 1) * remoteSize.width,
        y: point.y / max(baseSize.height, 1) * remoteSize.height))
  }
  @objc private func pointerChanged(_ gesture: ComputerPointerGesture) {
    guard controlling else { return }
    if gesture.state == .began { trackpadStart = remotePointer }
    if trackpad, gesture.moved {
      remotePointer = clamp(
        CGPoint(
          x: trackpadStart.x + (gesture.current.x - gesture.start.x) * remoteSize.width
            / max(baseSize.width, 1),
          y: trackpadStart.y + (gesture.current.y - gesture.start.y) * remoteSize.height
            / max(baseSize.height, 1)))
      updatePointer()
    }
    let p = trackpad ? remotePointer : remotePoint(gesture.current)
    if !trackpad { remotePointer = p }
    if gesture.state == .cancelled || gesture.state == .failed {
      releasePointer()
      return
    }
    if gesture.moved {
      if !trackpad || gesture.tapCount >= 2 {
        if !dragging {
          let start = trackpad ? trackpadStart : remotePoint(gesture.start)
          sendPointer("mousedown", start, buttons: 1)
          dragging = true
        }
        sendPointer("mousemove", p, buttons: 1)
        if gesture.state == .ended { sendPointer("mouseup", p, buttons: 0); dragging = false }
      } else { action(["action": .string("move"), "x": .number(p.x), "y": .number(p.y)]) }
    } else if gesture.state == .ended {
      let held = gesture.duration >= 0.55
      // Each completed tap is already sent once. Replaying the second as a
      // double-click would produce three remote clicks for two physical taps.
      click(p, right: held)
    }
  }
  private func sendPointer(_ phase: String, _ p: CGPoint, buttons: Int) {
    action(["action": .string("pointer"), "phase": .string(phase),
      "x": .number(p.x), "y": .number(p.y), "buttons": .number(Double(buttons))])
  }
  private func releasePointer() {
    guard dragging else { return }
    dragging = false
    sendPointer("mouseup", remotePointer, buttons: 0)
  }
  @objc private func twoTapped(_ gesture: UITapGestureRecognizer) {
    guard controlling, gesture.state == .ended else { return }
    click(trackpad ? remotePointer : point(gesture), right: true)
  }
  @objc private func twoPanned(_ gesture: UIPanGestureRecognizer) {
    if gesture.state == .began { viewportGesture = scroll.isZooming || scroll.zoomScale > 1.01 }
    guard controlling, gesture.state == .ended, !viewportGesture else { return }
    let delta = max(-20, min(20, Int((gesture.translation(in: self).y / 18).rounded())))
    if delta != 0 { action(["action": .string("scroll"), "deltaY": .number(Double(delta))]) }
  }
}
