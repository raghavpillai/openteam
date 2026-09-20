import Foundation

/// The list uses a diagonal pair or a 2×2 cluster. The chat title uses a strip.
public struct GroupAvatarLayout: Sendable {
  public enum Style: Sendable { case cluster, inline }
  public struct Slot: Sendable {
    public let x: Double, y: Double
  }
  public let slots: [Slot]
  public let memberSize: Double
  public let width: Double
  public let height: Double
  public let overflow: Int
  public let counter: Slot?
  public let counterFontSize: Double
  public let cutout: Double

  public init(count: Int, size: Double, style: Style, counterWidth: Double = 0) {
    let count = max(0, count)
    let visible = min(3, count)
    overflow = max(0, count - visible)
    height = size
    switch style {
    case .cluster:
      memberSize = count <= 1 ? size : size * (count == 2 ? 0.67 : 0.60)
      let step = size - memberSize
      slots = (0..<visible).map { index in
        if count == 2 { return Slot(x: Double(index) * step, y: Double(index) * step) }
        return Slot(x: index == 1 ? step : 0, y: index == 2 ? step : 0)
      }
      counter = overflow > 0 ? Slot(x: step, y: step) : nil
      counterFontSize = size * 0.46
      width = max(size, counter == nil ? size : step + counterWidth)
      cutout = size / 24
    case .inline:
      memberSize = size
      let step = size * 2 / 3
      slots = (0..<visible).map { Slot(x: Double($0) * step, y: 0) }
      let end = visible == 0 ? size : Double(visible - 1) * step + size
      counter = overflow > 0 ? Slot(x: end - size * 0.18, y: 0) : nil
      counterFontSize = size * 0.78
      width = counter.map { max(end, $0.x + counterWidth) } ?? end
      cutout = size / 14
    }
  }
}
