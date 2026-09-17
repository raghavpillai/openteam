import SwiftUI

@main
struct OpenTeamApp: App {
  @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var notificationDelegate
  @State private var store = AppStore()
  @AppStorage("appearance") private var appearance = "system"
  @AppStorage("accent") private var accent = "black"
  @Environment(\.scenePhase) private var scenePhase
  var body: some Scene {
    WindowGroup {
      Group {
        #if DEBUG
          if ProcessInfo.processInfo.arguments.contains("--bot-motion-lab") {
            RobotMotionLab()
          } else {
            LaunchContentView()
          }
        #else
          LaunchContentView()
        #endif
      }
      .environment(store)
      .foregroundStyle(NativePalette.text, NativePalette.muted, NativePalette.faint)
      .tint(accent == "blue" ? NativePalette.link : NativePalette.text)
      .toggleStyle(SwitchToggleStyle(tint: NativePalette.toggle))
      .preferredColorScheme(selectedAppearance)
      .onChange(of: scenePhase) { _, phase in store.setForeground(phase == .active) }
      .onOpenURL { url in Task { await store.deepLink(url) } }
    }
  }
  private var selectedAppearance: ColorScheme? {
    #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("--bot-motion-lab") {
        return ProcessInfo.processInfo.arguments.contains("--lab-dark") ? .dark : .light
      }
    #endif
    return appearance == "dark" ? .dark : appearance == "light" ? .light : nil
  }
}

extension Color {
  init(hex: String) {
    let h = hex.replacingOccurrences(of: "#", with: "")
    let value = UInt64(h, radix: 16) ?? 0xFD6A3A
    self.init(
      red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255,
      blue: Double(value & 255) / 255)
  }
}
struct RobotAvatar: View {
  var color: Color = Color(hex: "FD6A3A")
  var size: CGFloat = 48
  var group = false
  var body: some View { BotGlyph(color: color, kind: group ? "owl" : "chip", size: size) }
}
struct ChannelAvatar: View {
  @Environment(AppStore.self) private var store
  let channel: Channel
  var size: CGFloat = 48
  @State private var photo: UIImage?
  var body: some View {
    let bot = store.bot(for: channel)
    let runs = store.activeRuns(channel.id)
    func motion(_ botID: String?) -> RobotAvatarMode {
      guard store.activeChannel == channel.id, let botID,
        channel.members.contains(where: { $0.botId == botID })
      else { return .still }
      return runs.contains { $0.botId == botID && ["running", "queued"].contains($0.status) }
        ? .thinking : .idle
    }
    return Group {
      if let photo {
        Image(uiImage: photo).resizable().scaledToFill().frame(width: size, height: size).clipShape(
          Circle())
      } else if channel.isGroup {
        ZStack {
          ForEach(Array(channel.members.prefix(2).enumerated()), id: \.offset) { index, member in
            let memberBot = store.bots.first { $0.id == member.botId }
            BotGlyph(
              color: Color(hex: memberBot?.color ?? "7C5CFC"), kind: memberBot?.icon ?? "chip",
              size: size * 0.67,
              mode: motion(member.botId)
            )
            .offset(
              x: index == 0 ? -size * 0.16 : size * 0.16, y: index == 0 ? -size * 0.16 : size * 0.16
            )
          }
        }.frame(width: size, height: size)
      } else {
        BotGlyph(
          color: Color(hex: bot?.color ?? "7C5CFC"), kind: bot?.icon ?? "chip", size: size,
          mode: motion(bot?.id))
      }
    }.overlay(alignment: .bottomTrailing) {
      if size <= 30, !runs.isEmpty, !channel.isGroup {
        Circle().fill(Color(hex: "29A665")).frame(width: 9, height: 9)
          .overlay(Circle().stroke(NativePalette.background, lineWidth: 1))
          .offset(x: 1, y: 1).accessibilityHidden(true)
      }
    }.task(
      id:
        "\(bot?.id ?? channel.id)-\(bot?.hasAvatar ?? channel.hasAvatar)-\(bot?.icon ?? "")-\(bot?.color ?? "")"
    ) {
      photo = nil
      guard let bot, bot.hasAvatar, let api = store.api else { return }
      if let (data, _) = try? await api.raw("/api/v0/bots/\(API.segment(bot.id))/avatar") {
        photo = UIImage(data: data)
      }
    }
  }
}
