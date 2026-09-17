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
                    forceReducedMotion: reduced, sampleTime: sample)
                  Text(robot.rawValue).font(.system(size: 11)).lineLimit(1)
                }.accessibilityElement(children: .ignore).accessibilityLabel(robot.rawValue)
                  .accessibilityIdentifier("robot-cell-\(robot.rawValue)")
              }
            }
          } else {
            BotGlyph(
              color: Color(hex: "ff7a1a"), kind: shape.rawValue, size: 190, mode: mode,
              forceReducedMotion: reduced, sampleTime: sample
            )
            .frame(height: 220).accessibilityIdentifier("motion-stage")
          }
          Text("\(shape.rawValue) · \(mode.rawValue)").monospaced().accessibilityIdentifier(
            "motion-state")
          HStack {
            ForEach(RobotAvatarMode.allCases, id: \.self) { value in
              Button(value.rawValue) { mode = value }.buttonStyle(.bordered)
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
          for next in [RobotAvatarMode.idle, .thinking, .idle, .thinking, .still, .idle] {
            guard !Task.isCancelled else { return }
            mode = next
            try? await Task.sleep(for: .seconds(2))
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
        }
    }
  }
#endif
