import Foundation
import XCTest

@testable import OpenTeamCore

final class ComputerFrameTests: XCTestCase {
  let jpeg = Data([0xff, 0xd8, 0, 13, 10, 13, 10, 1, 0xff, 0xd9])
  func part(_ image: Data) -> Data {
    Data(
      "--openteam-frame\r\nContent-Type: image/jpeg\r\nContent-Length: \(image.count)\r\n\r\n".utf8)
      + image + Data("\r\n".utf8)
  }
  func testFragmentedAndCoalescedFramesPreserveBinaryBytes() throws {
    let wire = part(jpeg) + part(jpeg) + part(jpeg)
    for chunkSize in [1, 2, 7, 64, wire.count] {
      var decoder = ComputerFrameDecoder()
      var frames: [Data] = []
      for start in stride(from: 0, to: wire.count, by: chunkSize) {
        frames += try decoder.append(wire.subdata(in: start..<min(wire.count, start + chunkSize)))
      }
      XCTAssertEqual(frames, [jpeg, jpeg, jpeg])
    }
  }
  func testRejectsUnboundedAndAmbiguousResponses() throws {
    for header in [
      "Content-Type: image/jpeg\r\nContent-Length: 9999999999",
      "Content-Type: image/jpeg\r\nContent-Length: -1",
      "Content-Type: image/jpeg\r\nContent-Length: 10\r\nContent-Length: 9",
      "Content-Type: text/html\r\nContent-Length: 10",
    ] {
      var decoder = ComputerFrameDecoder()
      XCTAssertThrowsError(try decoder.append(Data("--openteam-frame\r\n\(header)\r\n\r\n".utf8)))
    }
    var decoder = ComputerFrameDecoder()
    XCTAssertThrowsError(try decoder.append(Data(repeating: 65, count: 4097)))
    var badFrame = ComputerFrameDecoder()
    XCTAssertThrowsError(try badFrame.append(part(Data("not a JPEG".utf8))))
    var badBoundary = ComputerFrameDecoder(boundary: "different")
    XCTAssertThrowsError(try badBoundary.append(part(jpeg)))
  }
  func testQueuesOnlyCompleteFrames() throws {
    var decoder = ComputerFrameDecoder()
    let wire = part(jpeg)
    XCTAssertEqual(try decoder.append(Data(wire.dropLast(4))), [])
    XCTAssertEqual(try decoder.append(Data(wire.suffix(4))), [jpeg])
  }
}
