import SwiftUI
import ThinkingOrbsKit

struct ComputerLoadingStatus: View {
  let desktopReady: Bool
  private var caption: String {
    desktopReady ? "Connecting to screen…" : "Starting computer…"
  }

  var body: some View {
    VStack(spacing: 8) {
      LoadingOrb(size: 20, theme: .dark, state: .connecting)
        .accessibilityHidden(true)
      ComputerLoadingCaption(text: caption)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("computer-loading-status")
  }
}

private struct ComputerLoadingCaption: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase
  let text: String
  private let base = Color(hex: "777A7D")
  private let highlight = Color(hex: "A1A4A6")
  private let font = Font.system(size: 10, weight: .regular)

  var body: some View {
    TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || scenePhase != .active)) { context in
      let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4
      Text(text)
        .font(font)
        .foregroundStyle(base)
        .overlay {
          if !reduceMotion {
            GeometryReader { geometry in
              LinearGradient(colors: [base, highlight, base], startPoint: .leading, endPoint: .trailing)
                .frame(width: geometry.size.width * 2)
                .offset(x: geometry.size.width * (phase * 3 - 2))
            }
            .mask(Text(text).font(font))
            .accessibilityHidden(true)
          }
        }
        .frame(height: 14)
    }
  }
}
