import SwiftUI

/// Quiet empty-chat surface, using OpenTeam's packaged Classic vector artwork.
/// BotGlyph pauses offscreen/inactive and respects the system Reduce Motion setting.
struct IdleConversationView: View {
  var body: some View {
    VStack(spacing: 12) {
      BotGlyph(color: NativePalette.text, kind: "classic", size: 76, mode: .idle)
      Text("Select a chat")
        .font(.system(size: 18)).foregroundStyle(NativePalette.muted)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .nativeCanvas()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Select a chat")
    .accessibilityIdentifier("idle-conversation")
  }
}
