#if DEBUG
  import SwiftUI

  struct RobotMotionLab: View {
    @State private var mode: RobotAvatarMode = .idle
    @State private var shape: RobotShape = .classic
    @State private var reduced = false
    @State private var running = false
    private let args = ProcessInfo.processInfo.arguments
    private var gallery: Bool { args.contains("--robot-gallery") }
    private var sample: Double? {
      guard let i = args.firstIndex(of: "--robot-sample"), i + 1 < args.count else { return nil }
      return Double(args[i + 1])
    }
    var body: some View {
      ScrollView {
        VStack(spacing: 18) {
          Text(gallery ? "Our desktop robots · Swift" : "Our robot · native motion").font(
            .title2.bold())
          if gallery {
            LazyVGrid(
              columns: Array(repeating: GridItem(.flexible(), spacing: 16), count: 3), spacing: 20
            ) {
              ForEach(RobotShape.allCases, id: \.self) { robot in
                VStack(spacing: 8) {
                  BotGlyph(
                    color: Color(hex: "ff7a1a"), kind: robot.rawValue, size: 96, mode: mode,
                    forceReducedMotion: reduced, sampleTime: sample, pokeable: true,
                    seed: robot.rawValue)
                  Text(robot.rawValue).font(.system(size: 11)).lineLimit(1)
                }.accessibilityElement(children: .ignore).accessibilityLabel(robot.rawValue)
                  .accessibilityIdentifier("robot-cell-\(robot.rawValue)")
              }
            }
          } else {
            BotGlyph(
              color: Color(hex: "ff7a1a"), kind: shape.rawValue, size: 190, mode: mode,
              forceReducedMotion: reduced, sampleTime: sample, pokeable: true
            )
            .frame(height: 220).accessibilityIdentifier("motion-stage")
          }
          Text(gallery ? mode.rawValue : "\(shape.rawValue) · \(mode.rawValue)").monospaced().accessibilityIdentifier(
            "motion-state")
          LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 8) {
            ForEach(RobotAvatarMode.allCases, id: \.self) { value in
              Button(value.rawValue) { mode = value }.buttonStyle(.bordered).font(.caption)
                .lineLimit(1).minimumScaleFactor(0.6)
                .accessibilityIdentifier("state-\(value.rawValue)")
            }
          }
          Toggle("Reduce motion", isOn: $reduced).accessibilityIdentifier("motion-reduced")
          if !gallery {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 14) {
              ForEach(RobotShape.allCases, id: \.self) { value in
                Button {
                  shape = value
                } label: {
                  VStack {
                    BotGlyph(color: Color(hex: "ff7a1a"), kind: value.rawValue, size: 40)
                    Text(value.rawValue).font(.system(size: 10)).lineLimit(1)
                  }.frame(minHeight: 60)
                }.accessibilityIdentifier("shape-\(value.rawValue)")
              }
            }
          }
          HStack {
            Button("Run transition tour") { running.toggle() }.accessibilityIdentifier(
              "motion-tour")
            Spacer()
            Text(running ? "Running" : "Ready").accessibilityIdentifier("motion-tour-status")
          }
        }.padding(24)
      }.background(NativePalette.background)
        .task(id: running) {
          guard running else { return }
          // One turn through every state, in the order a real run shows them.
          let tour: [(RobotAvatarMode, Double)] = [
            (.idle, 6), (.spawning, 2), (.thinking, 2.4), (.searching, 2.2), (.connecting, 2.3),
            (.writing, 2.5), (.sending, 2.2), (.generating, 2.9), (.working, 2.2), (.typing, 1.9),
            (.done, 6.4), (.waiting, 2.5), (.failed, 3.4), (.sleeping, 3.6), (.waking, 3), (.idle, 1),
          ]
          for (next, seconds) in tour {
            guard !Task.isCancelled else { return }
            mode = next
            try? await Task.sleep(for: .seconds(seconds))
          }
          // Then the taps: a spin, a bounce and a nod, and five quick ones for dizzy.
          for pause in [1.2, 1.2, 1.2, 0.2, 0.2, 0.2, 0.2, 0.2, 2.6] {
            guard !Task.isCancelled else { return }
            RobotLife.shared.demoPoke()
            try? await Task.sleep(for: .seconds(pause))
          }
          running = false
        }
        .onAppear {
          if let i = args.firstIndex(of: "--bot-state"), i + 1 < args.count {
            mode = .init(rawValue: args[i + 1]) ?? .idle
          }
          if let i = args.firstIndex(of: "--robot-shape"), i + 1 < args.count {
            shape = .init(icon: args[i + 1])
          }
          if args.contains("--robot-tour") { running = true }
        }
    }
  }
#endif
