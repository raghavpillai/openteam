import SwiftUI
import UIKit

struct ComputerSurface: UIViewRepresentable {
  let image: UIImage
  let remoteSize: CGSize
  let interactive: Bool
  let trackpad: Bool
  let action: ([String: JSON]) -> Void
  func makeUIView(context: Context) -> ComputerSurfaceView { ComputerSurfaceView() }
  func updateUIView(_ view: ComputerSurfaceView, context: Context) {
    view.configure(
      image: image, remoteSize: remoteSize, interactive: interactive, trackpad: trackpad,
      action: action)
  }
}

@MainActor
final class ComputerSurfaceView: UIView, UIScrollViewDelegate, UIGestureRecognizerDelegate {
  private let scroll = UIScrollView()
  private let picture = UIImageView()
  private let pointer = UIView()
  private var remoteSize = CGSize(width: 1280, height: 800)
  private var controlling = false
  private var trackpad = false
  private var action: ([String: JSON]) -> Void = { _ in }
  private var path: [CGPoint] = []
  private var remotePointer = CGPoint(x: 640, y: 400)
  private var lastTranslation = CGPoint.zero
  private var baseSize = CGSize.zero
  private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
  private lazy var doubleTap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
  private lazy var drag = UIPanGestureRecognizer(target: self, action: #selector(dragged(_:)))
  private lazy var hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
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
    doubleTap.numberOfTapsRequired = 2
    tap.require(toFail: doubleTap)
    drag.maximumNumberOfTouches = 1
    hold.minimumPressDuration = 0.55
    for recognizer in [tap, doubleTap, drag, hold] {
      recognizer.delegate = self
      picture.addGestureRecognizer(recognizer)
    }
    picture.accessibilityIdentifier = "computer-screen"
    picture.isAccessibilityElement = true
    picture.accessibilityLabel = "Live computer screen"
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  func configure(
    image: UIImage, remoteSize: CGSize, interactive: Bool, trackpad: Bool,
    action: @escaping ([String: JSON]) -> Void
  ) {
    picture.image = image
    self.remoteSize = remoteSize
    self.controlling = interactive
    self.trackpad = trackpad
    self.action = action
    scroll.panGestureRecognizer.minimumNumberOfTouches = interactive ? 2 : 1
    for recognizer in [tap, doubleTap, drag, hold] { recognizer.isEnabled = interactive }
    pointer.isHidden = !trackpad
    updatePointer()
    setNeedsLayout()
    picture.accessibilityHint =
      interactive
      ? "Tap to click, hold to right-click, drag with one finger, and pinch or pan with two fingers."
      : "Take control to interact. Pinch to zoom."
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    let changed = scroll.frame.size != bounds.size
    scroll.frame = bounds
    guard let image = picture.image else { return }
    let scale = min(
      bounds.width / max(image.size.width, 1), bounds.height / max(image.size.height, 1))
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    if size != baseSize || changed {
      scroll.zoomScale = 1
      baseSize = size
      picture.frame = CGRect(origin: .zero, size: size)
      scroll.contentSize = size
    }
    center()
    updatePointer()
  }
  func viewForZooming(in scrollView: UIScrollView) -> UIView? { picture }
  func scrollViewDidZoom(_ scrollView: UIScrollView) { center() }
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
  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    guard controlling, gesture.state == .ended else { return }
    click(trackpad ? remotePointer : point(gesture), double: gesture.numberOfTapsRequired == 2)
  }
  @objc private func held(_ gesture: UILongPressGestureRecognizer) {
    guard controlling, gesture.state == .began else { return }
    click(trackpad ? remotePointer : point(gesture), right: true)
  }
  @objc private func dragged(_ gesture: UIPanGestureRecognizer) {
    guard controlling else { return }
    if gesture.state == .began {
      path = [point(gesture)]
      lastTranslation = .zero
    }
    if trackpad {
      let delta = gesture.translation(in: self)
      remotePointer = clamp(
        CGPoint(
          x: remotePointer.x + (delta.x - lastTranslation.x) * remoteSize.width
            / max(baseSize.width * scroll.zoomScale, 1),
          y: remotePointer.y + (delta.y - lastTranslation.y) * remoteSize.height
            / max(baseSize.height * scroll.zoomScale, 1)))
      lastTranslation = delta
      updatePointer()
      return
    }
    if gesture.state == .changed || gesture.state == .ended {
      let p = point(gesture)
      if path.last != p { path.append(p) }
    }
    if gesture.state == .ended, path.count >= 2 {
      let step = max(1, Int(ceil(Double(path.count) / 99)))
      var samples = stride(from: 0, to: path.count, by: step).map { path[$0] }
      if samples.last != path.last { samples.append(path.last!) }
      action([
        "action": .string("drag"),
        "path": .array(
          samples.prefix(100).map { .object(["x": .number($0.x), "y": .number($0.y)]) }),
      ])
    }
  }
}
