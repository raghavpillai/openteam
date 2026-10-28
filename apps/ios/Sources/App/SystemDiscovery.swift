import AppIntents
import CoreSpotlight
import CryptoKit
import Observation
import SwiftUI

@MainActor @Observable
final class SystemDiscovery {
  static let shared = SystemDiscovery()
  nonisolated static let indexName = "dev.openteam.siri-content"
  private var revision = UUID()
  private var queued: Task<Void, Never>?
  private var debounce: Task<Void, Never>?
  private var manifest: [String: [String: String]] = [:]
  private let manifestKey = "system-discovery-manifest"
  var failure: String?

  private init() {
    if let data = UserDefaults.standard.data(forKey: manifestKey),
      let saved = try? JSONDecoder().decode([String: [String: String]].self, from: data) {
      manifest = saved
    }
  }

  static func enabled(scope: String) -> Bool {
    UserDefaults.standard.bool(forKey: "system-discovery-" + scope)
  }

  func update(session: SessionRecord, state: SavedState) {
    let scope = SystemEntityID.scope(server: session.server, userID: session.userID)
    guard Self.enabled(scope: scope), let bootstrap = state.bootstrap else { return }
    debounce?.cancel()
    let epoch = revision
    debounce = Task {
      do { try await Task.sleep(for: .seconds(1)) } catch { return }
      guard epoch == revision else { return }
      let previous = queued
      queued = Task {
        await previous?.value
        guard epoch == revision else { return }
        do {
          let snapshot = SystemDiscoverySnapshot(bootstrap: bootstrap, messages: state.messages)
          try await publish(snapshot, session: session, epoch: epoch)
          failure = nil
        } catch { failure = "Couldn’t update Siri and Spotlight: \(UserFacingError.message(error))" }
      }
    }
  }

  /// Serialize deletion after any in-flight write. Cancelling an async Spotlight
  /// call alone doesn't guarantee that the underlying index stops writing.
  func clear(removeTransfers: Bool = false) {
    revision = UUID()
    debounce?.cancel()
    debounce = nil
    let previous = queued
    queued = Task {
      await previous?.value
      do {
        try await Self.eraseIndex()
        manifest = [:]
        UserDefaults.standard.removeObject(forKey: manifestKey)
        failure = nil
      } catch { failure = "Couldn’t remove Siri and Spotlight content. OpenTeam will retry when you reconnect." }
      if removeTransfers {
        let transfers = FileManager.default.temporaryDirectory.appendingPathComponent("OpenTeamTransfers")
        try? FileManager.default.removeItem(at: transfers)
      }
    }
  }

  func clearAndWait() async {
    clear()
    await queued?.value
  }

  func setEnabled(_ enabled: Bool, session: SessionRecord, state: SavedState) {
    let scope = SystemEntityID.scope(server: session.server, userID: session.userID)
    UserDefaults.standard.set(enabled, forKey: "system-discovery-" + scope)
    clear()
    if enabled { update(session: session, state: state) }
  }

  func reindex() async throws {
    let client = try await SystemIntentClient.connect()
    guard Self.enabled(scope: client.scope) else { return }
    await clearAndWait()
    let epoch = revision
    let previous = queued
    let task = Task {
      await previous?.value
      guard epoch == revision else { return }
      do {
        try await publish(SystemDiscoverySnapshot(bootstrap: client.bootstrap, messages: [:]),
          session: client.session, epoch: epoch)
      } catch { failure = "Couldn’t rebuild Siri and Spotlight content: \(UserFacingError.message(error))" }
    }
    queued = task
    await task.value
  }

  private func validate(_ session: SessionRecord, epoch: UUID) throws {
    let scope = SystemEntityID.scope(server: session.server, userID: session.userID)
    guard epoch == revision, Self.enabled(scope: scope),
      !UserDefaults.standard.bool(forKey: LocalDataReset.pendingKey),
      let current = try SecureSession.read(), current.server == session.server,
      current.userID == session.userID, current.token == session.token else { throw CancellationError() }
  }

  private func publish(_ snapshot: SystemDiscoverySnapshot, session: SessionRecord, epoch: UUID) async throws {
    try validate(session, epoch: epoch)
    let scope = SystemEntityID.scope(server: session.server, userID: session.userID)
    // Hash only the projection that is donated, never credentials or instructions.
    func signature(_ parts: [String]) -> String {
      SHA256.hash(data: Data(parts.joined(separator: "\u{0}").utf8)).map { String(format: "%02x", $0) }.joined()
    }
    let targets = Dictionary(uniqueKeysWithValues: snapshot.destinations.map { ($0.id, $0) })
    let bots = snapshot.destinations.compactMap(\.bot)
    let botValues = bots.map { TeamBotEntity($0, scope: scope) }
    let botSignatures = Dictionary(uniqueKeysWithValues: zip(botValues, bots).map {
      ($0.0.id, signature([$0.1.name, $0.1.title]))
    })
    let conversationSignatures = Dictionary(uniqueKeysWithValues: snapshot.destinations.map {
      (TeamConversationEntity($0, scope: scope).id,
        signature([$0.name, $0.channel.updatedAt, String($0.channel.unreadCount ?? 0)] + $0.members.map(\.name)))
    })
    let messageSignatures = Dictionary(uniqueKeysWithValues: snapshot.messages.map {
      (SystemEntityID(scope: scope, kind: .message, channelID: $0.channelId, localID: $0.id).value,
        signature([$0.content, $0.createdAt, $0.senderBotId ?? "", targets[$0.channelId]?.name ?? ""]
          + $0.attachments.flatMap { [$0.assetId, $0.fileName, $0.mimeType] }))
    })
    if #available(iOS 27.0, *) {
      try await reconcile(bots.map { TeamSiriPerson($0, scope: scope) }, signatures: botSignatures,
        session: session, epoch: epoch)
      try await reconcile(snapshot.destinations.map { TeamSiriConversation($0, scope: scope) },
        signatures: conversationSignatures, session: session, epoch: epoch)
      let messages = snapshot.messages.compactMap { message -> TeamSiriMessage? in
        guard let target = targets[message.channelId] else { return nil }
        return TeamSiriMessage(message, target: target, scope: scope, owner: session.displayName)
      }
      try await reconcile(messages, signatures: messageSignatures, session: session, epoch: epoch)
    } else {
      try await reconcile(botValues, signatures: botSignatures, session: session, epoch: epoch)
      try await reconcile(snapshot.destinations.map { TeamConversationEntity($0, scope: scope) },
        signatures: conversationSignatures, session: session, epoch: epoch)
      try await reconcile(snapshot.messages.map {
        TeamMessageEntity($0, name: targets[$0.channelId]?.name ?? "OpenTeam", scope: scope)
      }, signatures: messageSignatures, session: session, epoch: epoch)
    }
  }

  private func reconcile<Entity: IndexedEntity>(_ values: [Entity], signatures: [String: String],
    session: SessionRecord, epoch: UUID) async throws where Entity.ID == String {
    try validate(session, epoch: epoch)
    let key = String(describing: Entity.self)
    let previous = manifest[key] ?? [:]
    let removed = previous.keys.filter { signatures[$0] == nil }
    if !removed.isEmpty {
      try await Self.removeEntities(Array(removed), type: Entity.self)
      try validate(session, epoch: epoch)
    }
    let changed = values.filter { previous[$0.id] != signatures[$0.id] }
    if !changed.isEmpty {
      try await Self.indexEntities(changed)
      try validate(session, epoch: epoch)
    }
    manifest[key] = signatures
    UserDefaults.standard.set(try JSONEncoder().encode(manifest), forKey: manifestKey)
  }

  // CSSearchableIndex isn't Sendable. Each operation owns its instance rather
  // than passing an actor-owned index to a nonisolated framework async method.
  nonisolated private static func eraseIndex() async throws {
    let index = CSSearchableIndex(name: indexName, protectionClass: .complete)
    try await index.deleteAllSearchableItems()
  }
  nonisolated private static func indexEntities<Entity: IndexedEntity>(_ values: [Entity]) async throws {
    let index = CSSearchableIndex(name: indexName, protectionClass: .complete)
    try await index.indexAppEntities(values)
  }
  nonisolated private static func removeEntities<Entity: IndexedEntity>(_ identifiers: [String], type: Entity.Type) async throws
  where Entity.ID == String {
    let index = CSSearchableIndex(name: indexName, protectionClass: .complete)
    try await index.deleteAppEntities(identifiedBy: identifiers, ofType: type)
  }
}

struct SystemMessageDraft: Identifiable {
  let id = UUID()
  let scope: String
  let text: String
  let attachments: [Asset]
}

struct SystemDraftPicker: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  let draft: SystemMessageDraft
  @State private var failure: String?
  var body: some View {
    NavigationStack {
      List {
        if let failure { Text(failure).foregroundStyle(.red) }
        if let bootstrap = store.state.bootstrap {
          ForEach(ShareDirectory.visible(ShareDirectory.destinations(bootstrap), query: "", selected: [])) { target in
            Button(target.name) {
              Task {
                do {
                  let id = TeamConversationEntity(target, scope: draft.scope).id
                  try await store.openSystemItem(id, draft: draft.text, attachments: draft.attachments)
                  dismiss()
                } catch { failure = UserFacingError.message(error) }
              }
            }
          }
        }
      }.navigationTitle("Choose a conversation")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    }
  }
}

struct SystemMessageContext: ViewModifier {
  @Environment(AppStore.self) private var store
  let message: Message
  let channel: Channel
  @ViewBuilder func body(content: Content) -> some View {
    if let scope = store.systemScope, store.systemDiscoveryEnabled {
      if #available(iOS 27.0, *) {
        content.appEntityIdentifier(EntityIdentifier(for: TeamSiriMessage.self,
          identifier: SystemEntityID(scope: scope, kind: .message,
            channelID: channel.id, localID: message.id).value))
      } else if #available(iOS 18.4, *) {
        content.appEntityIdentifier(EntityIdentifier(for: TeamMessageEntity.self,
          identifier: SystemEntityID(scope: scope, kind: .message,
            channelID: channel.id, localID: message.id).value))
      } else { content }
    } else { content }
  }
}

struct SystemDiscoverySettings: View {
  @Environment(AppStore.self) private var store
  var body: some View {
    Section {
      Toggle("Siri and Spotlight", isOn: Binding(get: { store.systemDiscoveryEnabled },
        set: { store.setSystemDiscoveryEnabled($0) }))
        .accessibilityIdentifier("system-discovery-toggle")
      if let failure = SystemDiscovery.shared.failure {
        Text(failure).font(.footnote).foregroundStyle(.secondary)
      }
    } footer: {
      Text("Let Siri understand visible messages and find recent conversations and messages in Spotlight on this device. Hidden conversations are excluded from the index. Shortcuts actions are available even when this is off.")
    }
  }
}
