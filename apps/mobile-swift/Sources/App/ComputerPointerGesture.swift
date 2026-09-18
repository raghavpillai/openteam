import UIKit

/// Classify one completed touch sequence once. Competing UIKit tap recognizers can
/// consume the beginning of a hold as the next tap in a rapid multi-tap sequence.
@MainActor final class ComputerPointerGesture: UIGestureRecognizer {
  private(set) var start = CGPoint.zero
  private(set) var current = CGPoint.zero
  private(set) var points: [CGPoint] = []
  private(set) var duration: TimeInterval = 0
  private(set) var tapCount = 0
  private var beganAt: TimeInterval = 0
  private var primary: UITouch?
  private(set) var moved = false

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    guard primary == nil, touches.count == 1,
      (event.allTouches?.filter { $0.phase != .ended && $0.phase != .cancelled }.count ?? 1) == 1,
      let touch = touches.first
    else {
      state = state == .possible ? .failed : .cancelled
      return
    }
    primary = touch
    start = touch.location(in: view)
    current = start
    points = [start]
    beganAt = touch.timestamp
    tapCount = touch.tapCount
  }
  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    guard let touch = primary, touches.contains(touch), state != .failed, state != .cancelled else {
      return
    }
    current = touch.location(in: view)
    points.append(current)
    moved = moved || hypot(current.x - start.x, current.y - start.y) >= 4
    if moved || state == .began || state == .changed {
      state = state == .possible ? .began : .changed
    }
  }
  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    guard let touch = primary, touches.contains(touch), state != .failed, state != .cancelled else {
      return
    }
    current = touch.location(in: view)
    if points.last != current { points.append(current) }
    duration = touch.timestamp - beganAt
    moved = moved || hypot(current.x - start.x, current.y - start.y) >= 4
    state = .ended
  }
  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    state = .cancelled
  }
  override func reset() {
    super.reset()
    primary = nil
    duration = 0
    moved = false
    points = []
  }
}
