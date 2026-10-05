/// A recycled document may render before WebKit adopts its native viewport.
/// Its height is usable only when measured at the current positive width.
enum DocumentHeightMeasurement {
  static func isValid(height: Double, width: Double, viewportWidth: Double) -> Bool {
    height.isFinite && height >= 0
      && width.isFinite && width > 0
      && viewportWidth.isFinite && viewportWidth > 0
      && abs(width - viewportWidth) <= 1
  }
}
