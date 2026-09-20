import SwiftUI

/// Activity state belongs to the one visible footer, not every transcript row.
struct ChatActivityFooter: View {
  @Environment(AppStore.self) private var store
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let channel: Channel
  var showsActivity = true
  @State private var visible = false
  @State private var mode: RobotAvatarMode = .still
  private var activity: RobotAvatarMode? {
    let runs = store.activeRuns(channel.id)
    return !showsActivity || runs.isEmpty ? nil
      : runs.contains { $0.status == "waiting_approval" } ? .idle : .thinking
  }
  var body: some View {
    VStack(spacing: 0) {
      let runs = store.activeRuns(channel.id)
      if let bot = store.bots.first(where: { $0.id == runs.first?.botId }) ?? store.bot(for: channel) {
        BotActivityRow(bot: bot, mode: mode, visible: visible)
      } else if activity != nil {
        ProgressView().frame(height: 54).padding(.bottom, 12)
      }
      Color.clear.frame(height: 11)
    }.padding(.horizontal, 16).padding(.top, 12)
      .animation(reduceMotion ? nil : .easeInOut(duration: visible ? 0.28 : 0.24), value: visible)
      .task(id: activity) {
        if let activity { mode = activity; visible = true }
        else {
          mode = .still
          if visible && !reduceMotion { try? await Task.sleep(for: .seconds(RobotMotion.transitionDuration)) }
          guard !Task.isCancelled else { return }
          visible = false
        }
      }
  }
}
