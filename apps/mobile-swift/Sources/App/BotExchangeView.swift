import SwiftUI

struct BotExchangeView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  let channel: Channel
  let peer: BotExchangePeer
  @State private var ready = false
  @State private var modals = MessageModalPresenter()
  private var source: Bot? { store.bot(for: channel) }
  private var peerBot: Bot? { store.bots.first { $0.id == peer.id } }
  private var messages: [Message] {
    store.messages(channel.id).filter { BotExchangePeer($0.metadata)?.id == peer.id }
  }
  var body: some View {
    ZStack {
      NativeMessageList(items: rows, initialTarget: peer.focusedMessageID ?? "bottom", onPositioned: { ready = true })
        .opacity(ready ? 1 : 0)
      if !ready { ProgressView().accessibilityLabel("Loading exchange") }
    }.messageModalHost(modals).nativeCanvas().toolbar(.hidden, for: .navigationBar)
      .chatFloatingBars(top: { header }, bottom: {
        Label("Read-only", systemImage: "lock")
          .font(.system(size: 13)).foregroundStyle(NativePalette.chatMuted)
          .padding(.horizontal, 12).frame(height: 38).nativeChatGlass()
          .accessibilityIdentifier("exchange-read-only")
          .frame(maxWidth: .infinity).padding(.top, 4)
      })
      .background(NativeBackGesture().frame(width: 0, height: 0))
  }
  private var header: some View {
    HStack(spacing: 8) {
      ChatChromeButton(title: "Back", symbol: "chevron.left", symbolSize: 18, symbolWeight: .regular) { dismiss() }
        .accessibilityIdentifier("exchange-back")
      HStack(spacing: -9) {
        if let source { MessageBotMark(bot: source, size: 29) }
        if let peerBot {
          MessageBotMark(bot: peerBot, size: 29)
            .background(NativePalette.background, in: Circle().inset(by: -2))
        }
      }.padding(.leading, 8).accessibilityElement(children: .ignore)
        .accessibilityLabel((source?.name ?? channel.name) + " and " + peer.name)
      Spacer()
    }.padding(.horizontal, 18).padding(.vertical, 6)
  }
  private var rows: [NativeHistoryItem] {
    var result: [NativeHistoryItem] = []
    if store.histories[channel.id]?.hasMore == true {
      let busy = store.busy.contains("history-" + channel.id)
      result.append(NativeHistoryItem(id: "earlier", scrollID: "earlier", version: busy.hashValue) {
        AnyView(Button("Load earlier messages") { Task { await store.loadHistory(channel.id, older: true) } }
          .font(.footnote).frame(maxWidth: .infinity).padding(14).disabled(busy))
      })
    }
    let timeline = MessageTimeline(messages, includeBranched: true)
    for entry in timeline.entries {
      let message = entry.message
      let speaker = BotExchangePeer(message.metadata)?.incoming == true ? peerBot : source
      result.append(NativeHistoryItem(id: message.id, scrollID: message.id, version: message.hashValue) {
        AnyView(VStack(spacing: 12) {
          if let date = entry.timestamp {
            Text(chatTimestamp(date)).font(.system(size: 13)).foregroundStyle(NativePalette.chatFaint)
              .frame(maxWidth: .infinity).padding(.top, 14).padding(.bottom, 2)
          }
          MessageRow(message: message, channel: channel, onReply: {}, onThread: {},
            viewOnly: true, speakerOverride: speaker)
        }
          .padding(.horizontal, 16).padding(.top, 12).environment(store).environment(modals))
      })
    }
    result.append(NativeHistoryItem(id: "bottom", scrollID: "bottom", version: messages.isEmpty.hashValue) {
      AnyView(Group {
        if messages.isEmpty { Text("No exchange messages loaded.").font(.footnote).foregroundStyle(NativePalette.muted).padding() }
        Color.clear.frame(height: 14)
      })
    })
    return result
  }
}

struct MessageBotMark: View {
  @Environment(AppStore.self) private var store
  let bot: Bot
  let size: CGFloat
  var body: some View {
    if let channel = store.channel(bot.dmChannelId) {
      ChannelAvatar(channel: channel, size: size, showsActivity: false)
    } else {
      BotGlyph(color: Color(hex: bot.color), kind: bot.icon, size: size)
    }
  }
}
