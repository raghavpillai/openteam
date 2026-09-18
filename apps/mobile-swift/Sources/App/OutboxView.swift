import SwiftUI

struct PendingAttachments: View {
  let pending: PendingSend
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(pending.stagedFiles ?? []) { file in
        identity(file.fileName, size: file.byteSize, mime: file.mimeType)
      }
      ForEach(Array(pending.input.attachments.enumerated()), id: \.offset) { _, file in
        identity(file.fileName, size: file.byteSize, mime: file.mimeType)
      }
    }
  }
  private func identity(_ name: String, size: Int, mime: String) -> some View {
    Label {
      VStack(alignment: .leading, spacing: 3) {
        Text(name).lineLimit(2)
        Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
          .font(.caption).foregroundStyle(NativePalette.muted)
      }
    } icon: {
      Image(
        systemName: mime.hasPrefix("image/") ? "photo" : mime.hasPrefix("video/") ? "film" : "doc")
    }.padding(12).background(NativePalette.surface, in: RoundedRectangle(cornerRadius: 14))
  }
}

struct OutboxView: View {
  @Environment(AppStore.self) private var store
  @State private var recovering: PendingSend?
  @State private var discarding: PendingSend?
  var body: some View {
    NativeForm {
      if store.state.outbox.isEmpty {
        Text("No queued messages").foregroundStyle(NativePalette.muted)
      }
      ForEach(store.state.outbox) { pending in
        Section(store.channel(pending.channelId)?.name ?? "Unavailable conversation") {
          if !pending.input.content.isEmpty { Text(pending.input.content).textSelection(.enabled) }
          PendingAttachments(pending: pending)
          Text(pending.failure ?? (store.online ? "Sending…" : "Queued · offline"))
            .font(.footnote).foregroundStyle(NativePalette.muted)
          if store.channel(pending.channelId) == nil {
            Button("Recover to a draft") { recovering = pending }
          } else if pending.failure != nil {
            Button("Retry") { Task { await store.retry(pending.id) } }
          }
          Button("Discard", role: .destructive) { discarding = pending }
        }.accessibilityIdentifier("queued-" + pending.id)
      }
    }.navigationTitle("Queued messages").navigationBarTitleDisplayMode(.inline)
      .sheet(item: $recovering) { pending in
        NavigationStack {
          List(store.channels) { channel in
            Button(channel.name) {
              if store.recoverPending(pending.id, to: channel.id) { recovering = nil }
            }
          }.navigationTitle("Recover to a draft")
            .toolbar {
              ToolbarItem(placement: .cancellationAction) { Button("Cancel") { recovering = nil } }
            }
        }
      }
      .confirmationDialog(
        "Discard this queued message?",
        isPresented: Binding(
          get: { discarding != nil }, set: { if !$0 { discarding = nil } }
        ), titleVisibility: .visible
      ) {
        Button("Discard", role: .destructive) {
          if let pending = discarding { store.discard(pending.id) }
          discarding = nil
        }
        Button("Cancel", role: .cancel) { discarding = nil }
      }
  }
}
