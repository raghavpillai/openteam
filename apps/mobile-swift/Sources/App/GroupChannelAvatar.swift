import SwiftUI

struct GroupChannelAvatar: View {
  @Environment(AppStore.self) private var store
  let channel: Channel
  let size: CGFloat
  let style: GroupAvatarLayout.Style
  @State private var photos: [String: UIImage] = [:]
  private var members: [Channel.Member] { channel.members }
  private var revision: String {
    members.prefix(3).map { member in
      let bot = store.bots.first { $0.id == member.botId }
      return "\(member.botId):\(bot?.hasAvatar ?? false):\(bot?.updatedAt ?? "")"
    }.joined(separator: "|")
  }
  var body: some View {
    let base = GroupAvatarLayout(count: members.count, size: size, style: style)
    let font = UIFont.systemFont(ofSize: base.counterFontSize, weight: .medium)
    let counterWidth = ceil(
      ("+\(base.overflow)" as NSString).size(withAttributes: [.font: font]).width)
    let layout = GroupAvatarLayout(
      count: members.count, size: size, style: style, counterWidth: counterWidth)
    ZStack(alignment: .topLeading) {
      if members.isEmpty {
        Image(systemName: "person.2.fill").font(.system(size: size * 0.55))
          .foregroundStyle(NativePalette.muted).frame(width: size, height: size)
      }
      ForEach(Array(layout.slots.enumerated()), id: \.offset) { index, slot in
        member(index, edge: layout.memberSize)
          .frame(width: layout.memberSize, height: layout.memberSize)
          .mask {
            Rectangle().overlay(alignment: .topLeading) {
              ZStack(alignment: .topLeading) {
                ForEach(Array(layout.slots.enumerated().dropFirst(index + 1)), id: \.offset) {
                  next, nextSlot in
                  member(next, edge: layout.memberSize, cutout: layout.cutout)
                    .offset(x: nextSlot.x - slot.x, y: nextSlot.y - slot.y)
                }
                if let counter = layout.counter {
                  counterText(layout, outline: layout.cutout)
                    .offset(x: counter.x - slot.x, y: counter.y - slot.y)
                }
              }.blendMode(.destinationOut)
            }.compositingGroup()
          }
          .offset(x: slot.x, y: slot.y)
      }
      if let counter = layout.counter {
        counterText(layout).offset(x: counter.x, y: counter.y)
      }
    }
    .frame(width: layout.width, height: layout.height, alignment: .topLeading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(members.count) bots")
    .accessibilityValue(layout.overflow > 0 ? "+\(layout.overflow) more" : "")
    .accessibilityIdentifier("group-avatar-\(channel.id)")
    .task(id: revision) {
      photos = [:]
      guard let api = store.api else { return }
      for member in members.prefix(3) {
        guard !Task.isCancelled else { return }
        guard let bot = store.bots.first(where: { $0.id == member.botId }), bot.hasAvatar else {
          continue
        }
        if let (data, _) = try? await api.raw("/api/v0/bots/\(API.segment(bot.id))/avatar"),
          !Task.isCancelled, let image = UIImage(data: data)
        {
          photos[bot.id] = image
        }
      }
    }
  }
  @ViewBuilder private func member(_ index: Int, edge: CGFloat, cutout: CGFloat? = nil) -> some View
  {
    let id = members[index].botId
    let bot = store.bots.first { $0.id == id }
    if let image = photos[id] {
      if let cutout {
        Circle().fill(.black).overlay(Circle().stroke(.black, lineWidth: cutout * 2))
          .frame(width: edge, height: edge)
      } else {
        Image(uiImage: image).resizable().scaledToFill().frame(width: edge, height: edge)
          .clipShape(Circle())
      }
    } else {
      let mode: RobotAvatarMode =
        store.activeChannel == channel.id
        ? (store.activeRuns(channel.id).contains {
          $0.botId == id && ["running", "queued"].contains($0.status)
        }
          ? .thinking : .idle) : .still
      BotGlyph(
        color: Color(hex: bot?.color ?? "7C5CFC"), kind: bot?.icon ?? "chip", size: edge,
        mode: mode, cutout: cutout)
    }
  }
  private func counterText(_ layout: GroupAvatarLayout, outline: CGFloat = 0) -> some View {
    Text("+\(layout.overflow)").font(.system(size: layout.counterFontSize, weight: .medium))
      .foregroundStyle(outline > 0 ? Color.black : NativePalette.chatFaint)
      .fixedSize().frame(height: layout.memberSize)
      .background {
        if outline > 0 {
          ForEach(0..<8) { i in
            Text("+\(layout.overflow)").font(.system(size: layout.counterFontSize, weight: .medium))
              .foregroundStyle(.black).fixedSize()
              .offset(x: cos(Double(i) * .pi / 4) * outline, y: sin(Double(i) * .pi / 4) * outline)
          }
        }
      }
  }
}
