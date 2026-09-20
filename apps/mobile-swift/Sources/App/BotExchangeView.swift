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
        VStack(spacing: 10) {
          Label("This chat is view-only", systemImage: "lock.fill")
            .font(.footnote).foregroundStyle(NativePalette.muted)
          Button("Close Chat") { dismiss() }.buttonStyle(.bordered).buttonBorderShape(.capsule)
            .accessibilityIdentifier("exchange-close")
        }.frame(maxWidth: .infinity).padding(.vertical, 12)
      })
      .background(NativeBackGesture().frame(width: 0, height: 0))
  }
  private var header: some View {
    HStack(spacing: 8) {
      ChatChromeButton(title: "Back", symbol: "chevron.left", symbolSize: 18, symbolWeight: .regular) { dismiss() }
      HStack(spacing: 6) {
        identity(source, name: source?.name ?? channel.name)
        Image(systemName: "arrow.left.arrow.right").font(.caption).foregroundStyle(NativePalette.muted)
        identity(peerBot, name: peer.name)
      }.padding(.horizontal, 12).frame(height: 44).nativeChatGlass()
        .frame(maxWidth: .infinity)
      Color.clear.frame(width: 44, height: 44)
    }.padding(.horizontal, 18).padding(.vertical, 6)
  }
  private func identity(_ bot: Bot?, name: String) -> some View {
    HStack(spacing: 5) {
      if let bot { MessageBotMark(bot: bot, size: 20) }
      Text(name).font(.system(size: 14, weight: .medium)).lineLimit(1)
    }
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
    for message in messages {
      let speaker = BotExchangePeer(message.metadata)?.incoming == true ? peerBot : source
      result.append(NativeHistoryItem(id: message.id, scrollID: message.id, version: message.hashValue) {
        AnyView(MessageRow(message: message, channel: channel, onReply: {}, onThread: {},
          viewOnly: true, speakerOverride: speaker)
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
