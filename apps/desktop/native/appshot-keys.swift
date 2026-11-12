// appshot-keys: reports when both of a modifier's keys (left and right) go down together,
// e.g. both Command keys, for the appshot shortcut. Electron's globalShortcut can't express
// a chord of modifiers alone.
//
// Usage: appshot-keys --chord command|option|shift|control
// stdout: "ready tap" | "ready poll", then "trigger" for each chord.
// stdin:  "chord <name>" switches the chord, "pause" / "resume", EOF exits.
//
// With Input Monitoring granted it listens to modifier changes through a passive event tap,
// so it costs nothing while idle. Without it, it reads the global modifier state on a slow
// timer (20 Hz, about 0.3% of one core), speeding up only while one of the chord's keys is held.
//
// appshot-keys --request-access asks macOS for Input Monitoring and prints the result.

import ApplicationServices
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

struct Chord {
  let left: UInt64
  let right: UInt64
  /** Device-independent bit of this modifier, so other modifiers can be told apart. */
  let own: UInt64

  static func named(_ name: String) -> Chord? {
    switch name {
    case "command": return Chord(left: 0x08, right: 0x10, own: CGEventFlags.maskCommand.rawValue)
    case "option": return Chord(left: 0x20, right: 0x40, own: CGEventFlags.maskAlternate.rawValue)
    case "shift": return Chord(left: 0x02, right: 0x04, own: CGEventFlags.maskShift.rawValue)
    case "control": return Chord(left: 0x01, right: 0x2000, own: CGEventFlags.maskControl.rawValue)
    default: return nil
    }
  }
}

let otherModifiers: UInt64 =
  CGEventFlags.maskCommand.rawValue | CGEventFlags.maskAlternate.rawValue | CGEventFlags.maskShift.rawValue
  | CGEventFlags.maskControl.rawValue | CGEventFlags.maskSecondaryFn.rawValue

/// Both sides down within a short window, with no other modifier held and no key pressed in
/// between, fires once; it re-arms when both are released. Holding one side for a shortcut
/// (⌘C) and then touching the other doesn't count, and neither does rolling between the two
/// Shift keys while typing.
final class ChordDetector {
  var chord: Chord
  var paused = false
  private var armed = true
  private var leftDownAt: TimeInterval?
  private var rightDownAt: TimeInterval?
  static let window: TimeInterval = 0.5

  init(chord: Chord) { self.chord = chord }

  /// Returns true when the chord fires. `lastKeyDown` is when an ordinary key last went down
  /// (system uptime), if known.
  func update(flags: UInt64, now: TimeInterval, lastKeyDown: TimeInterval? = nil) -> Bool {
    let left = flags & chord.left != 0
    let right = flags & chord.right != 0
    if left { leftDownAt = leftDownAt ?? now } else { leftDownAt = nil }
    if right { rightDownAt = rightDownAt ?? now } else { rightDownAt = nil }
    if !left && !right {
      armed = true
      return false
    }
    guard armed, let l = leftDownAt, let r = rightDownAt else { return false }
    armed = false
    let others = flags & otherModifiers & ~chord.own
    let typedBetween = lastKeyDown.map { $0 >= min(l, r) } ?? false
    return !paused && others == 0 && !typedBetween && abs(l - r) <= ChordDetector.window
  }

  /// Whether a key of this chord is held (polling runs faster while it is).
  func holding(_ flags: UInt64) -> Bool { flags & (chord.left | chord.right) != 0 }
}

if CommandLine.arguments.contains("--request-access") {
  print(CGRequestListenEventAccess() ? "granted" : "denied")
  exit(0)
}
if CommandLine.arguments.contains("--check-access") {
  print(CGPreflightListenEventAccess() ? "granted" : "denied")
  exit(0)
}

if CommandLine.arguments.contains("--self-test") {
  // Exercises the real detector with modifier-flag sequences (left/right bits plus the
  // device-independent bit macOS sets alongside them).
  let cmd = CGEventFlags.maskCommand.rawValue, opt = CGEventFlags.maskAlternate.rawValue
  let shift = CGEventFlags.maskShift.rawValue, ctrl = CGEventFlags.maskControl.rawValue
  var failures: [String] = []
  func run(_ name: String, _ chord: String, _ steps: [(UInt64, TimeInterval)], paused: Bool = false, expect: Int) {
    let detector = ChordDetector(chord: Chord.named(chord)!)
    detector.paused = paused
    let fired = steps.filter { detector.update(flags: $0.0, now: $0.1) }.count
    if fired != expect { failures.append("\(name): fired \(fired), expected \(expect)") }
  }
  run("both command keys", "command", [(cmd | 0x08, 0), (cmd | 0x18, 0.08), (cmd | 0x18, 0.3), (0, 0.5)], expect: 1)
  run("right then left", "command", [(cmd | 0x10, 0), (cmd | 0x18, 0.1), (0, 0.4)], expect: 1)
  run("again after release", "command", [(cmd | 0x18, 0), (0, 0.2), (cmd | 0x08, 0.5), (cmd | 0x18, 0.55), (0, 0.8)], expect: 2)
  run("held for a shortcut first", "command", [(cmd | 0x08, 0), (cmd | 0x18, 0.9), (0, 1.2)], expect: 0)
  run("with shift held", "command", [(cmd | shift | 0x0A, 0), (cmd | shift | 0x1A, 0.05), (0, 0.3)], expect: 0)
  run("one side only", "command", [(cmd | 0x08, 0), (0, 0.2), (cmd | 0x10, 0.3), (0, 0.5)], expect: 0)
  run("paused while recording", "command", [(cmd | 0x08, 0), (cmd | 0x18, 0.05), (0, 0.3)], paused: true, expect: 0)
  run("both option keys", "option", [(opt | 0x20, 0), (opt | 0x60, 0.05), (0, 0.3)], expect: 1)
  run("command doesn't fire option", "option", [(cmd | 0x18, 0), (0, 0.3)], expect: 0)
  // A key typed while one side is held (⌘C), then the other side: not the chord.
  do {
    let detector = ChordDetector(chord: Chord.named("command")!)
    let fired = [detector.update(flags: cmd | 0x08, now: 0), detector.update(flags: cmd | 0x18, now: 0.35, lastKeyDown: 0.1)]
    if fired.contains(true) { failures.append("typed between: fired") }
    let clean = ChordDetector(chord: Chord.named("command")!)
    if !(clean.update(flags: cmd | 0x08, now: 1) || clean.update(flags: cmd | 0x18, now: 1.1, lastKeyDown: 0.5)) {
      failures.append("key long before the chord: didn't fire")
    }
  }
  run("both control keys", "control", [(ctrl | 0x01, 0), (ctrl | 0x2001, 0.05), (0, 0.3)], expect: 1)
  print(failures.isEmpty ? "ok" : failures.joined(separator: "\n"))
  exit(failures.isEmpty ? 0 : 1)
}

var chordName = "command"
if let index = CommandLine.arguments.firstIndex(of: "--chord"), index + 1 < CommandLine.arguments.count {
  chordName = CommandLine.arguments[index + 1]
}
guard let initial = Chord.named(chordName) else {
  FileHandle.standardError.write("unknown chord \(chordName)\n".data(using: .utf8)!)
  exit(2)
}
let detector = ChordDetector(chord: initial)
let parent = getppid()

func emit(_ line: String) {
  print(line)
}

/// The last ordinary key press the event tap saw (system uptime).
var tapKeyDownAt: TimeInterval = -1

func handle(flags: UInt64) {
  let now = ProcessInfo.processInfo.systemUptime
  // The system's own "last key press" works without Input Monitoring, for the poll mode; the
  // tap adds the presses it sees itself.
  let sinceKey = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
  let lastKeyDown = max(tapKeyDownAt, now - sinceKey)
  if detector.update(flags: flags, now: now, lastKeyDown: lastKeyDown) { emit("trigger") }
}

// Commands from the app on stdin; EOF means the app is gone.
let input = FileHandle.standardInput
var pending = Data()
input.readabilityHandler = { handle in
  let data = handle.availableData
  if data.isEmpty { exit(0) }
  pending.append(data)
  while let newline = pending.firstIndex(of: 0x0A) {
    let line = String(decoding: pending[pending.startIndex..<newline], as: UTF8.self)
    pending.removeSubrange(pending.startIndex...newline)
    let parts = line.split(separator: " ").map(String.init)
    DispatchQueue.main.async {
      switch parts.first {
      case "chord": if parts.count > 1, let next = Chord.named(parts[1]) { detector.chord = next }
      case "pause": detector.paused = true
      case "resume": detector.paused = false
      default: break
      }
    }
  }
}

// The app quitting without closing stdin (a crash) still ends this process: the kernel
// reports the parent's exit, so nothing polls for it.
let parentWatch = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
parentWatch.setEventHandler { exit(0) }
parentWatch.resume()
if getppid() != parent || kill(parent, 0) != 0 { exit(0) }

var usingTap = false
var tapPort: CFMachPort?
if CGPreflightListenEventAccess() {
  let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue) | CGEventMask(1 << CGEventType.keyDown.rawValue)
  let callback: CGEventTapCallBack = { _, type, event, _ in
    switch type {
    case .flagsChanged:
      handle(flags: event.flags.rawValue)
    case .keyDown:
      // Only matters while a chord key is held (it cancels the chord); otherwise ignore it.
      if detector.holding(event.flags.rawValue) { tapKeyDownAt = ProcessInfo.processInfo.systemUptime }
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
      // macOS can disable a tap; turn it back on right here instead of on a timer.
      if let port = tapPort { CGEvent.tapEnable(tap: port, enable: true) }
    default:
      break
    }
    return Unmanaged.passUnretained(event)
  }
  if let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
    eventsOfInterest: mask, callback: callback, userInfo: nil)
  {
    tapPort = tap
    let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    usingTap = true
  }
}

if !usingTap {
  // Slow while idle, fast while a chord key is held, so a quick press is never missed. The
  // timer's leeway lets macOS coalesce its wakeups with others.
  let timer = DispatchSource.makeTimerSource(queue: .main)
  var fast = false
  func schedule(_ hz: Double) {
    timer.schedule(deadline: .now() + 1 / hz, repeating: 1 / hz, leeway: .milliseconds(hz > 60 ? 2 : 15))
  }
  timer.setEventHandler {
    let flags = CGEventSource.flagsState(.combinedSessionState).rawValue
    handle(flags: flags)
    let holding = detector.holding(flags)
    if holding != fast {
      fast = holding
      schedule(holding ? 120 : 20)
    }
  }
  schedule(20)
  timer.resume()
}

emit(usingTap ? "ready tap" : "ready poll")
RunLoop.main.run()
