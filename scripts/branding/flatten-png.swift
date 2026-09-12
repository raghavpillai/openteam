import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// Opaque RGB fallbacks are valid for both Expo and legacy app-icon consumers.
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let context = CGContext(data: nil, width: image.width, height: image.height,
        bitsPerComponent: 8, bytesPerRow: image.width * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
  fatalError("Cannot read icon PNG")
}
context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
guard let flattened = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
  fatalError("Cannot write icon PNG")
}
CGImageDestinationAddImage(destination, flattened, nil)
if !CGImageDestinationFinalize(destination) { fatalError("PNG export failed") }
