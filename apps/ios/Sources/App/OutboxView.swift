import SwiftUI

struct PendingAttachments: View {
  @Environment(AppStore.self) private var store
  let pending: PendingSend
  @State private var previews: PendingAttachmentPreviews

  init(pending: PendingSend, previews: PendingAttachmentPreviews = .init()) {
    self.pending = pending
    _previews = State(initialValue: previews)
  }

  var body: some View {
    VStack(alignment: .trailing, spacing: 5) {
      ForEach(previews.items(pending, api: store.api, fileURL: store.stagedFileURL)) { item in
        if item.staged, let preview = item.local {
          StagedAttachmentPreview(preview: preview)
        } else {
          AttachmentView(asset: item.asset, channelID: pending.channelId,
            messageID: pending.id, localPreview: item.local)
        }
      }
    }
  }
}

struct OutboxView: View {
  @State private var modals = MessageModalPresenter()
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
          if store.channel(pending.channelId) == nil {
            Button("Recover to a draft") { recovering = pending }
          } else {
            PendingSendStatus(pending: pending)
          }
          Button("Discard", role: .destructive) { discarding = pending }
        }.accessibilityIdentifier("queued-" + pending.id)
      }
    }.navigationTitle("Queued messages").navigationBarTitleDisplayMode(.inline)
      .environment(modals).messageModalHost(modals)
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

/// Delivery uncertainty stays distinct from a confirmed send failure.
struct PendingSendStatus: View {
  @Environment(AppStore.self) private var store
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let pending: PendingSend
  var showsSending = true
  private var unconfirmed: Bool {
    pending.deliveryUnconfirmed == true && store.activeSendID != pending.id
  }
  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      if pending.failure != nil || unconfirmed || showsSending {
        Text(unconfirmed ? "Delivery unconfirmed" : pending.failure != nil ? "Not delivered" : "Sending…")
          .foregroundStyle(NativePalette.muted)
      }
      if pending.failure != nil || unconfirmed {
        Button {
          Task { await store.retry(pending.id) }
        } label: {
          Text("Retry").padding(.horizontal, 8).frame(minHeight: 44, alignment: .top)
        }.buttonStyle(.plain).background(KeyboardPreservingControl())
          .padding(.trailing, -8)
          .accessibilityIdentifier("retry-send-" + pending.id)
      }
    }.font(.caption)
      .animation(reduceMotion ? nil : .easeOut(duration: 0.20), value: pending.failure != nil || unconfirmed)
      .transition(.opacity)
  }
}

/// A delayed retry indicator; it does not replay the bubble's arrival.
struct SendingRetryBar: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var sweeping = false
  var body: some View {
    Capsule().fill(NativePalette.muted.opacity(0.15))
      .overlay(alignment: .leading) {
        Capsule().fill(NativePalette.muted).frame(width: 8, height: 2)
          .offset(x: reduceMotion ? 8 : sweeping ? 24 : -8)
          .animation(reduceMotion ? nil : .timingCurve(0.42, 0, 0.58, 1, duration: 1.2)
            .repeatForever(autoreverses: false), value: sweeping)
      }
      .frame(width: 24, height: 2).clipped()
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Retrying message")
      .accessibilityIdentifier("send-progress")
      .onAppear { sweeping = true }
  }
}
