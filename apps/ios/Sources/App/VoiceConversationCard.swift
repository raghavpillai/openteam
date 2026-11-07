import SwiftUI

/// A realtime voice exchange, collapsed by default; tapping reveals the transcript.
struct VoiceConversationCard: View {
  let messages: [Message]
  @State private var expanded = false
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
      } label: {
        HStack(spacing: 8) {
          Image(systemName: "mic.fill").font(.system(size: 13))
          Text("Voice conversation · \(messages.count) messages").font(.system(size: 14))
          Spacer()
          Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(size: 12))
        }.foregroundStyle(NativePalette.muted).contentShape(Rectangle())
      }.buttonStyle(.plain)
        .accessibilityIdentifier("voice-conversation-card")
        .accessibilityValue(expanded ? "expanded" : "collapsed")
      if expanded {
        ForEach(messages) { message in
          (Text(message.isUser ? "You  " : "Assistant  ").font(.system(size: 12))
            .foregroundStyle(NativePalette.muted) + Text(message.content).font(.system(size: 14)))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }.padding(.horizontal, 14).padding(.vertical, 10)
      .background(RoundedRectangle(cornerRadius: 14).fill(NativePalette.muted.opacity(0.12)))
  }
}
