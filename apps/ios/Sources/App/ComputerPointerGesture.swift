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
  private var lastTap: (endedAt: TimeInterval, point: CGPoint)?
  private(set) var moved = false

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    guard primary == nil, touches.count == 1,
      (event.allTouches?.filter { $0.phase != .ended && $0.phase != .cancelled }.count ?? 1) == 1,
      let touch = touches.first
    else {
      lastTap = nil
      state = state == .possible ? .failed : .cancelled
      return
    }
    primary = touch
    start = touch.location(in: view)
    current = start
    points = [start]
    beganAt = touch.timestamp
    // Recognition resets between completed touches. Preserve a short, local
    // tap sequence for trackpad tap-then-drag even when UIKit reports one tap.
    let followsTap = lastTap.map {
      touch.timestamp - $0.endedAt <= 0.5
        && hypot(start.x - $0.point.x, start.y - $0.point.y) <= 22
    } ?? false
    tapCount = max(touch.tapCount, followsTap ? 2 : 1)
    lastTap = nil
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
    lastTap = !moved && duration < 0.3 ? (touch.timestamp, current) : nil
    state = .ended
  }
  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    lastTap = nil
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
