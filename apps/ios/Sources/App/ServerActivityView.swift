import SwiftUI

private struct SystemActivity: Decodable {
  let cpuPercent: Double?
  let memoryPercent: Double?
  let diskPercent: Double?
}

struct ServerActivitySection: View {
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  @State private var visible = false
  @State private var activity: SystemActivity?
  @State private var failed = false
  private var polling: Bool { visible && scenePhase == .active }

  var body: some View {
    Section {
      HStack(spacing: 12) {
        ResourceGauge(label: "CPU", value: activity?.cpuPercent)
        ResourceGauge(label: "RAM", value: activity?.memoryPercent)
        ResourceGauge(label: "Disk", value: activity?.diskPercent)
      }.padding(.vertical, 12)
    } header: {
      HStack {
        Text("Live activity")
        Spacer()
        Circle().fill(activity == nil || !polling ? Color.secondary : Color.green)
          .frame(width: 5, height: 5).accessibilityHidden(true)
        Text(
          !polling
            ? "Paused"
            : failed
              ? "Unavailable · retrying" : activity == nil ? "Connecting…" : "Every 5 seconds"
        )
        .font(.caption2)
      }.textCase(nil)
    } footer: {
      Text(
        "System CPU & RAM · OpenTeam data disk. In Docker, system usage is for the Linux host/VM.")
    }
    .onAppear { visible = true }
    .onDisappear { visible = false }
    .task(id: polling) {
      guard polling else { return }
      activity = nil
      failed = false
      while !Task.isCancelled {
        let started = Date()
        do {
          let result = try await store.request("/api/v0/system/activity", timeout: 4.5)
            .decode(SystemActivity.self)
          try Task.checkCancellation()
          activity = result
          failed = false
        } catch {
          guard !Task.isCancelled else { return }
          activity = nil
          failed = true
        }
        do {
          try await Task.sleep(for: .seconds(max(0, 5 - Date().timeIntervalSince(started))))
        } catch { return }
      }
    }
  }
}

private struct ResourceGauge: View {
  let label: String
  let value: Double?
  private var percent: Int? {
    guard let value, value.isFinite else { return nil }
    return Int(min(100, max(0, value)).rounded())
  }
  private var color: Color {
    guard let percent else { return .secondary }
    return percent < 70
      ? NativePalette.color("16845B", "34D399")
      : percent < 90
        ? NativePalette.color("B97808", "FBBF24") : NativePalette.color("DC4545", "F87171")
  }
  var body: some View {
    VStack(spacing: 7) {
      GeometryReader { geometry in
        let width = geometry.size.width
        ZStack {
          GaugeArc().stroke(
            .primary.opacity(0.08), style: StrokeStyle(lineWidth: 7, lineCap: .round))
          if let percent, percent > 0 {
            GaugeArc().trim(from: 0, to: Double(percent) / 100)
              .stroke(color, style: StrokeStyle(lineWidth: 7, lineCap: .round))
          }
          VStack(spacing: 1) {
            Text(percent.map { "\($0)%" } ?? "—")
              .font(.system(size: 23, weight: .semibold, design: .rounded))
              .monospacedDigit().foregroundStyle(color).minimumScaleFactor(0.7)
            Text("used").font(.system(size: 10)).foregroundStyle(.secondary)
          }.offset(y: width * 0.06)
          HStack {
            Text("0")
            Spacer()
            Text("100")
          }
          .font(.system(size: 9)).foregroundStyle(.secondary)
          .padding(.horizontal, 3).frame(maxHeight: .infinity, alignment: .bottom)
        }
      }.aspectRatio(1.15, contentMode: .fit)
      Text(label).font(.system(size: 13, weight: .medium))
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
    .accessibilityValue(percent.map { "\($0)% used" } ?? "Unavailable")
    .accessibilityIdentifier("server-activity-" + label.lowercased())
  }
}

private struct GaugeArc: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    path.addArc(
      center: CGPoint(x: rect.midX, y: rect.width * 0.5),
      radius: rect.width * 0.43,
      startAngle: .degrees(155), endAngle: .degrees(385), clockwise: false)
    return path
  }
}
