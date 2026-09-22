import UIKit

/// Draws the shared SVG primitives locally, including their affine face projection.
/// Artwork.json is generated from design-tokens by generate-notification-artwork.ts.
enum RobotNotificationAvatar {
  private static let artwork: [String: [[String: Any]]] = {
    guard let url = Bundle.main.url(forResource: "RobotArtwork", withExtension: "json"),
          let data = try? Data(contentsOf: url),
          let value = try? JSONSerialization.jsonObject(with: data) as? [String: [[String: Any]]] else { return [:] }
    return value
  }()

  static func image(icon: String?, color: String?) -> UIImage? {
    guard let nodes = artwork[icon ?? ""] ?? artwork["chip"] else { return nil }
    let hex = color?.replacingOccurrences(of: "#", with: "") ?? "4f7cff"
    let rgb = hex.count == 6 ? (UInt32(hex, radix: 16) ?? 0x4f7cff) : 0x4f7cff
    let body = UIColor(red: CGFloat((rgb >> 16) & 255) / 255,
                       green: CGFloat((rgb >> 8) & 255) / 255,
                       blue: CGFloat(rgb & 255) / 255, alpha: 1)
    let face = rgb == 0x242424 ? UIColor(white: 0.95, alpha: 1) : UIColor(red: 27/255, green: 27/255, blue: 29/255, alpha: 1)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: CGSize(width: 144, height: 144), format: format).image { renderer in
      let context = renderer.cgContext
      // Match the profile avatar's -4 -4 108 108 viewBox.
      context.scaleBy(x: 144/108, y: 144/108)
      context.translateBy(x: 4, y: 4)
      for node in nodes { draw(node, context: context, body: body, face: face) }
    }
  }

  private static func draw(_ node: [String: Any], context: CGContext, body: UIColor, face: UIColor) {
    let attrs = node["attributes"] as? [String: Any] ?? [:]
    func number(_ key: String, _ fallback: CGFloat = 0) -> CGFloat {
      if let value = attrs[key] as? String, let value = Double(value) { return CGFloat(value) }
      return (attrs[key] as? NSNumber).map { CGFloat($0.doubleValue) } ?? fallback
    }
    func ink(_ value: String) -> CGColor {
      value == "currentColor" ? body.cgColor : face.cgColor
    }
    context.saveGState()
    defer { context.restoreGState() }
    if let opacity = attrs["opacity"] { context.setAlpha(CGFloat(Double("\(opacity)") ?? 1)) }
    if let fill = attrs["fill"] as? String { context.setFillColor(ink(fill)) }
    if let stroke = attrs["stroke"] as? String { context.setStrokeColor(ink(stroke)) }
    context.setLineWidth(number("strokeWidth", 1))
    if attrs["strokeLinejoin"] as? String == "round" { context.setLineJoin(.round) }
    if attrs["strokeLinecap"] as? String == "round" { context.setLineCap(.round) }
    if let style = attrs["style"] as? [String: String], style["transform"]?.contains("perspective") == true {
      context.translateBy(x: 52, y: 0)
      context.scaleBy(x: 0.9703, y: 1)
      context.translateBy(x: -50, y: 0)
    }
    if let transform = attrs["transform"] as? String {
      let regex = try! NSRegularExpression(pattern: "(translate|scale|rotate)\\(([^)]+)\\)")
      let source = transform as NSString
      for match in regex.matches(in: transform, range: NSRange(location: 0, length: source.length)) {
        let args = source.substring(with: match.range(at: 2)).split { $0 == " " || $0 == "," }.compactMap { Double($0).map { CGFloat($0) } }
        guard let first = args.first else { continue }
        switch source.substring(with: match.range(at: 1)) {
        case "translate": context.translateBy(x: first, y: args.count > 1 ? args[1] : 0)
        case "scale": context.scaleBy(x: first, y: args.count > 1 ? args[1] : first)
        case "rotate":
          let x = args.count > 2 ? args[1] : 0, y = args.count > 2 ? args[2] : 0
          context.translateBy(x: x, y: y); context.rotate(by: first * .pi / 180); context.translateBy(x: -x, y: -y)
        default: break
        }
      }
    }
    let shape: UIBezierPath
    switch node["tag"] as? String {
    case "g":
      for child in node["children"] as? [[String: Any]] ?? [] { draw(child, context: context, body: body, face: face) }
      return
    case "rect": shape = UIBezierPath(roundedRect: CGRect(x: number("x"), y: number("y"), width: number("width"), height: number("height")), cornerRadius: number("rx"))
    case "circle": shape = UIBezierPath(ovalIn: CGRect(x: number("cx") - number("r"), y: number("cy") - number("r"), width: number("r") * 2, height: number("r") * 2))
    case "line":
      shape = UIBezierPath(); shape.move(to: CGPoint(x: number("x1"), y: number("y1"))); shape.addLine(to: CGPoint(x: number("x2"), y: number("y2")))
    case "polygon":
      shape = UIBezierPath()
      let points = (attrs["points"] as? String ?? "").split { $0 == " " || $0 == "," }.compactMap { Double($0).map { CGFloat($0) } }
      for i in stride(from: 0, to: points.count - 1, by: 2) {
        let point = CGPoint(x: points[i], y: points[i+1]); if i == 0 { shape.move(to: point) } else { shape.addLine(to: point) }
      }
      shape.close()
    default: return
    }
    context.addPath(shape.cgPath)
    context.drawPath(using: attrs["stroke"] == nil ? .fill : (attrs["fill"] as? String == "none" || node["tag"] as? String == "line" ? .stroke : .fillStroke))
  }
}
