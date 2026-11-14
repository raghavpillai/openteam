import XCTest

@testable import OpenTeamCore

/// Replays moments sampled from the shipping desktop robots (output/bot-avatar-motion/scripts/
/// parity-dump.mjs) and checks that the Swift engine puts every element in the same place.
final class RobotParityTests: XCTestCase {
  private struct Case: Decodable {
    struct Step: Decodable {
      var mode: String, seconds: Double
      init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        mode = try container.decode(String.self)
        seconds = try container.decode(Double.self)
      }
    }
    struct Robot: Decodable { var phase: Double, elements: [String: [Double]] }
    var steps: [Step], robots: [String: Robot]
  }
  func testEveryElementMatchesTheDesktop() throws {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "robot-parity", withExtension: "json", subdirectory: "Fixtures"))
    let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: url))
    var worst: [(Double, String)] = []
    var notBlinks: [String] = []
    var checked = 0
    for sample in cases {
      for (name, robot) in sample.robots {
        let shape = try XCTUnwrap(RobotShape(rawValue: name))
        let rig = try XCTUnwrap(RobotRig.shared[shape])
        var motion = RobotMotion(shape: shape, mode: .idle)
        motion.phase = robot.phase
        var history: [RobotMotion] = []
        var pacer = RobotModePacer(.idle)
        var now = 0.0
        // The sampler resets through failed and idle before each case.
        let reset = [("working", 0.5), ("failed", 1.0), ("idle", 1.2)]
        for (mode, seconds) in reset + sample.steps.map({ ($0.mode, $0.seconds) }) {
          pacer.request(try XCTUnwrap(RobotAvatarMode(rawValue: mode)))
          motion.setMode(pacer.shown(at: now))
          for _ in 0..<Int((seconds * 60).rounded()) {
            history.append(motion)
            now += 1.0 / 60
            motion.advance(by: 1.0 / 60)
            motion.setMode(pacer.shown(at: now))
          }
        }
        // Frame boundaries are the browser's business, so each element may sit up to three
        // frames either side of the sample.
        var candidates = history.suffix(3).map { $0.frames() } + [motion.frames()]
        var later = motion
        for step in 1...3 {
          later.advance(by: 1.0 / 60)
          later.setMode(pacer.shown(at: now + Double(step) / 60))
          candidates.append(later.frames())
        }
        let present = min(3, history.count)
        func world(_ id: String, _ frames: [String: RobotElementFrame]) -> RobotAffine {
          guard let element = rig.index[id].map({ rig.elements[$0] }) else { return .identity }
          var own = frames[id]?.transform ?? .identity
          if element.node?.perspective != true { own = own.about(element.origin) }
          let parent = element.parent.map { $0 == "glyph" ? world("rig", frames) : world($0, frames) } ?? .identity
          return parent.concatenating(own)
        }
        func hidden(_ id: String, _ frames: [String: RobotElementFrame]) -> Bool {
          guard let element = rig.index[id].map({ rig.elements[$0] }) else { return false }
          return frames[id]?.visible == false || (element.parent.map { hidden($0, frames) } ?? false)
        }
        let label = sample.steps.map { "\($0.mode) \($0.seconds)" }.joined(separator: " > ")
        for (id, expected) in robot.elements {
          // An SVG transform attribute is baked into the shape here, not into its matrix.
          if rig[id].node?.transform.isEmpty == false { continue }
          guard candidates[present][id] != nil else {
            XCTFail("\(name) has no element \(id)")
            continue
          }
          checked += 1
          let error = candidates.map { frames -> Double in
            let frame = frames[id]!
            var error = zip(world(id, frames).values, expected[0..<6]).map { abs($0 - $1) }.max() ?? 0
            error = max(error, abs(frame.opacity - expected[6]) * 10)
            if hidden(id, frames) != (expected[7] == 0) { error = max(error, 100) }
            if rig[id].node?.dashed == true { error = max(error, abs((1 - frame.strokeEnd) * 100 - expected[8]) / 10) }
            return error
          }.min()!
          let frame = candidates[present][id]!
          let frames = candidates[present]
          if let debug = ProcessInfo.processInfo.environment["PARITY_DEBUG"], debug == "\(name)|\(label)", error > 0.5 {
            print("PARITY-DEBUG", id, rig[id].node?.part ?? "", rig[id].node?.roles ?? [:], "got", world(id, frames).values.map { ($0 * 1000).rounded() / 1000 }, frame.opacity, "want", expected)
          }
          if error > 0.5 {
            let part = rig[id].node.map { "\($0.part)\($0.roles)" } ?? ""
            let eye = { (id: String) in ["eyes", "visor"].contains(rig[id].node?.part ?? "") }
            // A fast glyph dot riding the fold can pair two neighbouring frames; allow a unit.
            if error >= 1, !eye(id) && !(rig[id].parent.map(eye) ?? false) { notBlinks.append("\(name) \(id) [\(label)]") }
            worst.append((error, "\(String(format: "%.3f", error)) \(name) \(id) \(part) [\(label)]"))
          }
        }
      }
    }
    worst.sort { $0.0 > $1.0 }
    var byElement: [String: Int] = [:]
    for (_, text) in worst { byElement[text.split(separator: "[").last.map(String.init) ?? "", default: 0] += 1 }
    print("PARITY checked \(checked), off by more than 0.5: \(worst.count)")
    for (label, count) in byElement.sorted(by: { $0.value > $1.value }).prefix(40) { print("PARITY-CASE \(count) [\(label)") }
    for (_, text) in worst.prefix(60) { print("PARITY-WORST", text) }
    // What is left is blinks: an eyelid closes within two frames, so a sample that lands on
    // its edge can differ. Everything else must match.
    XCTAssertLessThan(Double(worst.count), Double(checked) * 0.004)
    XCTAssertEqual(notBlinks, [], "elements other than eyes are off")
  }
}
