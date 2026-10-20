import Intents
import QuickLookThumbnailing
import SwiftUI
import ThinkingOrbsKit
import UIKit
import UniformTypeIdentifiers

/// Share sheet entry point. A tapped conversation suggestion arrives as an INSendMessageIntent
/// whose conversationIdentifier is the Bot's DM channel (or a group channel).
final class ShareViewController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    let model = ShareModel(context: extensionContext)
    let host = UIHostingController(rootView: ShareView(model: model))
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)
    Task { await model.load() }
  }
}

/// A share destination plus what its row shows.
struct ShareTarget: Identifiable {
  var destination: ShareDestination
  var subtitle: String
  var avatars: [UIImage]
  var id: String { destination.id }
  var channel: Channel { destination.channel }
  var bot: Bot? { destination.bot }
  var name: String { destination.name }
}

struct SharedFile: Identifiable {
  let id = UUID()
  var url: URL
  var fileName: String
  var type: UTType
  var mimeType: String
  var byteSize: Int
  var thumbnail: UIImage?

  var isVisual: Bool { type.conforms(to: .image) || type.conforms(to: .movie) }
  var isVideo: Bool { Self.videoExtensions.contains(url.pathExtension.lowercased()) }
  /// Mirrors the server: the file name, not the declared MIME type, decides the video allowance.
  var limit: Int { (isVideo ? 200 : 25) * 1024 * 1024 }
  var problem: String? {
    byteSize > limit ? "Too large · max \(limit / 1024 / 1024) MB" : nil
  }
  var symbol: String {
    if type.conforms(to: .pdf) { return "doc.richtext" }
    if type.conforms(to: .movie) { return "film" }
    if type.conforms(to: .audio) { return "waveform" }
    if type.conforms(to: .image) { return "photo" }
    if type.conforms(to: .archive) { return "doc.zipper" }
    if type.conforms(to: .spreadsheet) { return "tablecells" }
    if type.conforms(to: .presentation) { return "rectangle.on.rectangle" }
    if type.conforms(to: .sourceCode) { return "chevron.left.forwardslash.chevron.right" }
    if type.conforms(to: .text) { return "doc.text" }
    return "doc"
  }
  private static let videoExtensions: Set<String> = ["m4v", "mov", "mp4", "ogv", "webm"]
}

@MainActor final class ShareModel: ObservableObject {
  enum Phase { case loading, ready, signedOut, failed(String) }
  static let maximumFiles = 6

  @Published var phase = Phase.loading
  @Published var targets: [ShareTarget] = []
  @Published var selected: [String] = []
  @Published var sent: Set<String> = []
  @Published var query = ""
  @Published var text = ""
  @Published var files: [SharedFile] = []
  @Published var error: String?
  @Published var sending = false
  /// Uploaded Bot or group photos, loaded after the list appears.
  @Published var photos: [String: UIImage] = [:]
  let suggested: String?
  private let context: NSExtensionContext?
  private var api: API?
  private var itemsLoaded = false
  private var uploaded: [UUID: Asset] = [:]
  private var clientIDs: [String: String] = [:]

  init(context: NSExtensionContext?) {
    self.context = context
    suggested = (context?.intent as? INSendMessageIntent)?.conversationIdentifier
  }

  var visibleTargets: [ShareTarget] {
    let visible = ShareDirectory.visible(targets.map(\.destination), query: query, selected: Set(selected))
    let ids = Set(visible.map(\.id))
    return targets.filter { ids.contains($0.id) }
  }
  var hasContent: Bool {
    !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty
  }
  var canSend: Bool {
    guard case .ready = phase else { return false }
    return !selected.isEmpty && hasContent && !sending && files.allSatisfy { $0.problem == nil }
  }
  /// Mirrors the app composer's "Ask <Bot>" prompt so the recipient is obvious before typing.
  var prompt: String {
    let chosen = selected.compactMap { id in targets.first { $0.id == id } }
    switch chosen.count {
    case 0: return "Add a message"
    case 1: return (chosen[0].bot == nil ? "Message " : "Ask ") + chosen[0].name
    default: return chosen.allSatisfy { $0.bot != nil } ? "Message \(chosen.count) Bots" : "Message \(chosen.count) chats"
    }
  }
  var sendLabel: String {
    let names = selected.compactMap { id in targets.first { $0.id == id }?.name }
    return names.isEmpty ? "Send" : "Send to " + names.formatted(.list(type: .and))
  }

  func load() async {
    phase = .loading
    if !itemsLoaded {
      itemsLoaded = true
      await loadItems()
    }
    do {
      guard let session = try SecureSession.read() else {
        phase = .signedOut
        return
      }
      let api = try API(server: session.server, token: session.token)
      self.api = api
      targets = Self.targets(try await api.get("/api/v0/client-bootstrap", as: Bootstrap.self))
      if let suggested, let index = targets.firstIndex(where: { $0.id == suggested }) {
        targets.insert(targets.remove(at: index), at: 0)
        if selected.isEmpty { selected = [suggested] }
      }
      phase = .ready
      for target in targets where target.bot?.hasAvatar ?? target.channel.hasAvatar {
        photos[target.id] = await ConversationDonation.avatar(channel: target.channel, bot: target.bot, api: api)
      }
    } catch let failure as APIError where failure.unauthorized {
      phase = .signedOut
    } catch {
      phase = .failed(error.localizedDescription)
    }
  }

  /// Most recent first (see ShareDirectory), with a role or "Group" and how long ago.
  static func targets(_ bootstrap: Bootstrap) -> [ShareTarget] {
    let relative = RelativeDateTimeFormatter()
    relative.unitsStyle = .short
    var robots: [String: UIImage] = [:]
    func robot(_ bot: Bot) -> UIImage? {
      if let image = robots[bot.id] { return image }
      let image = RobotNotificationAvatar.image(icon: bot.icon, color: bot.color)
      robots[bot.id] = image
      return image
    }
    return ShareDirectory.destinations(bootstrap).map { destination in
      let when = destination.lastActivity.map { relative.localizedString(for: $0, relativeTo: Date()) }
      let role = destination.bot?.title.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      let label = destination.bot == nil ? "Group" : (role.isEmpty ? nil : role)
      return ShareTarget(
        destination: destination,
        subtitle: [label, when].compactMap { $0 }.joined(separator: " · "),
        avatars: destination.members.prefix(destination.bot == nil ? 2 : 1).compactMap(robot))
    }
  }

  func toggle(_ id: String) {
    UISelectionFeedbackGenerator().selectionChanged()
    if let index = selected.firstIndex(of: id) { selected.remove(at: index) } else { selected.append(id) }
  }

  func remove(_ file: SharedFile) {
    files.removeAll { $0.id == file.id }
    uploaded[file.id] = nil
    if files.count <= Self.maximumFiles, error?.contains("files at once") == true { error = nil }
  }

  func cancel() {
    removeCopies()
    context?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
  }

  /// Each shared file was copied into its own temporary folder.
  private func removeCopies() {
    for file in files { try? FileManager.default.removeItem(at: file.url.deletingLastPathComponent()) }
  }

  /// Uploads each file once, then posts one message per chosen conversation. A retry reuses the
  /// uploaded assets and each conversation's client ID, so the server never duplicates a message.
  func send() async {
    guard let api, canSend else { return }
    sending = true
    error = nil
    defer { sending = false }
    do {
      var assets: [Asset] = []
      for file in files {
        if let asset = uploaded[file.id] {
          assets.append(asset)
          continue
        }
        let asset = try await upload(file, api: api)
        uploaded[file.id] = asset
        assets.append(asset)
      }
      let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
      for id in selected where !sent.contains(id) {
        guard let target = targets.first(where: { $0.id == id }) else { continue }
        let clientID = clientIDs[id] ?? UUID().uuidString
        clientIDs[id] = clientID
        _ = try await api.send(
          channel: target.channel, bot: target.bot,
          input: SendInput(content: content, clientId: clientID, attachments: assets))
        sent.insert(id)
        ConversationDonation.donateSent(
          channel: target.channel, bot: target.bot, image: photos[id] ?? target.avatars.first)
      }
      UINotificationFeedbackGenerator().notificationOccurred(.success)
      removeCopies()
      context?.completeRequest(returningItems: nil)
    } catch {
      UINotificationFeedbackGenerator().notificationOccurred(.error)
      self.error = error.localizedDescription
    }
  }

  /// Streams from disk so a 200 MB video never has to fit in the extension's memory limit.
  private func upload(_ file: SharedFile, api: API) async throws -> Asset {
    var request = URLRequest(url: api.url("/api/v0/assets"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(file.mimeType, forHTTPHeaderField: "Content-Type")
    request.setValue(
      file.fileName.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "File",
      forHTTPHeaderField: "x-file-name")
    if let token = api.token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.timeoutIntervalForRequest = 120
    configuration.timeoutIntervalForResource = 900
    let session = URLSession(configuration: configuration, delegate: RedirectPolicy(), delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    let (data, response) = try await session.upload(for: request, fromFile: file.url)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let json = (try? JSONDecoder().decode(JSON.self, from: data)) ?? .null
      let message = [json["error"]["message"].string, json["message"].string].first { !$0.isEmpty }
      throw APIError(
        message ?? "Couldn’t upload \(file.fileName).",
        status: (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
    return try JSONDecoder().decode(Asset.self, from: data)
  }

  /// Web links become message text. Anything file-backed, including Markdown and other text
  /// documents, becomes an attachment; only loose text snippets are inlined.
  private func loadItems() async {
    var lines: [String] = []
    let providers = context?.inputItems.compactMap { $0 as? NSExtensionItem }.flatMap { $0.attachments ?? [] } ?? []
    for provider in providers {
      let types = provider.registeredTypeIdentifiers.compactMap(UTType.init)
      if types.contains(where: { $0.conforms(to: .url) && !$0.conforms(to: .fileURL) }),
        let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL
      {
        if url.isFileURL {
          if let file = Self.copy(url, type: nil) { files.append(file) }
        } else {
          lines.append(url.absoluteString)
        }
        continue
      }
      let fileBacked = provider.suggestedName != nil || !types.contains { $0.conforms(to: .text) }
      if !fileBacked, types.contains(where: { $0.conforms(to: .plainText) }),
        let item = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier)
      {
        if let string = item as? String {
          lines.append(string)
          continue
        }
        if let data = item as? Data, let string = String(data: data, encoding: .utf8) {
          lines.append(string)
          continue
        }
      }
      if let type = types.first(where: { !$0.conforms(to: .url) }),
        let file = await copy(provider, type: type, suggestedName: provider.suggestedName)
      {
        files.append(file)
      }
    }
    if files.count > Self.maximumFiles {
      files = Array(files.prefix(Self.maximumFiles))
      error = "You can share up to \(Self.maximumFiles) files at once. The first \(Self.maximumFiles) were kept."
    }
    text = lines.joined(separator: "\n")
    for index in files.indices where files[index].isVisual || files[index].type.conforms(to: .pdf) {
      files[index].thumbnail = await Self.thumbnail(files[index].url)
    }
  }

  /// The provider deletes its temporary file when the handler returns, so copy it first.
  private func copy(_ provider: NSItemProvider, type: UTType, suggestedName: String?) async -> SharedFile? {
    await withCheckedContinuation { continuation in
      _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
        continuation.resume(returning: url.flatMap { Self.copy($0, type: type) })
      }
    }
  }

  nonisolated private static func copy(_ source: URL, type: UTType?) -> SharedFile? {
    let access = source.startAccessingSecurityScopedResource()
    defer { if access { source.stopAccessingSecurityScopedResource() } }
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let destination = folder.appendingPathComponent(source.lastPathComponent)
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      try FileManager.default.copyItem(at: source, to: destination)
      let byType = UTType(filenameExtension: destination.pathExtension)
      let resolved = byType ?? type ?? .data
      let size = (try? destination.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
      return SharedFile(
        url: destination, fileName: destination.lastPathComponent, type: resolved,
        mimeType: resolved.preferredMIMEType ?? type?.preferredMIMEType ?? "application/octet-stream",
        byteSize: size)
    } catch {
      return nil
    }
  }

  private static func thumbnail(_ url: URL) async -> UIImage? {
    let request = QLThumbnailGenerator.Request(
      fileAt: url, size: CGSize(width: 64, height: 64), scale: UIScreen.main.scale,
      representationTypes: .thumbnail)
    return try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request).uiImage
  }
}

/// Styled like the app itself: the conversation list's canvas, rows and robots, and the chat
/// composer's glass field with its black arrow pill. System pieces (title, close, search) stay native.
struct ShareView: View {
  @ObservedObject var model: ShareModel
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    NavigationStack {
      content
        .background(NativePalette.background.ignoresSafeArea())
        .navigationTitle("Share to")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel", systemImage: "xmark", role: .cancel) { model.cancel() }
          }
        }
        .searchable(text: $model.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search")
        .floatingBar(edge: .bottom) {
          // Nothing can be sent while signed out or before the Bot list loads successfully.
          switch model.phase {
          case .loading, .ready: composer
          case .signedOut, .failed: EmptyView()
          }
        }
    }
    .tint(NativePalette.text)
  }

  @ViewBuilder private var content: some View {
    switch model.phase {
    case .loading:
      ZStack { ThinkingOrb(state: .composing, size: .px20, displaySize: 20) }
        .accessibilityElement(children: .ignore).accessibilityLabel("Loading")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .signedOut:
      ContentUnavailableView(
        "Connect OpenTeam First", systemImage: "person.crop.circle.badge.exclamationmark",
        description: Text("Open OpenTeam, connect to your server, then share again."))
    case .failed(let message):
      ContentUnavailableView {
        Label("Couldn’t Load Your Bots", systemImage: "wifi.exclamationmark")
      } description: {
        Text(message)
      } actions: {
        Button("Try Again") { Task { await model.load() } }
      }
    case .ready:
      let rows = model.visibleTargets
      if rows.isEmpty && !model.query.isEmpty {
        ContentUnavailableView.search(text: model.query)
      } else if rows.isEmpty {
        ContentUnavailableView(
          "No Bots Yet", systemImage: "person.crop.circle.badge.plus",
          description: Text("Create a Bot in OpenTeam to share with it."))
      } else {
        List {
          Section {
            ForEach(rows) { target in
              row(target)
                .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                .listRowSeparator(.hidden)
                .listRowBackground(NativePalette.background)
            }
          } header: {
            Text(model.query.isEmpty ? "Recent" : "Results")
              .font(.system(size: 14)).foregroundStyle(NativePalette.faint).textCase(nil)
              .padding(.leading, 4)  // Align with the 20-point row inset.
          }
          .listSectionSeparator(.hidden)
        }
        .listStyle(.plain)
        .contentMargins(.top, 0, for: .scrollContent)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.immediately)
      }
    }
  }

  private func row(_ target: ShareTarget) -> some View {
    let isSelected = model.selected.contains(target.id)
    return Button { model.toggle(target.id) } label: {
      HStack(spacing: 14) {
        ShareAvatar(photo: model.photos[target.id], robots: target.avatars).frame(width: 44, height: 44)
        VStack(alignment: .leading, spacing: 3) {
          Text(target.name).font(.system(size: 17, weight: .medium)).foregroundStyle(NativePalette.text)
            .lineLimit(1)
          if !target.subtitle.isEmpty {
            Text(target.subtitle).font(.system(size: 15)).foregroundStyle(NativePalette.muted).lineLimit(1)
          }
        }
        Spacer(minLength: 8)
        if model.sent.contains(target.id) {
          Text("Sent").font(.system(size: 15)).foregroundStyle(NativePalette.muted)
        }
        SelectionMark(selected: isSelected)
      }
      .padding(.vertical, 10)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("share.target.\(target.name)")
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let error = model.error {
        Label(error, systemImage: "exclamationmark.circle.fill")
          .font(.footnote).foregroundStyle(NativePalette.destructive)
          .padding(.horizontal, 4)
      }
      if !model.files.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(model.files) { file in
              AttachmentChip(file: file) { model.remove(file) }
            }
          }
          .padding(.top, 6)
          .padding(.trailing, 6)
        }
        .scrollClipDisabled()
      }
      field
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
    .padding(.bottom, 8)
    .background {
      // Like the app's floating chat bars: rows fade into the canvas instead of
      // showing through attachment chips and the glass field.
      LinearGradient(
        stops: [
          .init(color: NativePalette.background.opacity(0), location: 0),
          .init(color: NativePalette.background, location: model.files.isEmpty ? 0.45 : 0.3),
        ],
        startPoint: .top, endPoint: .bottom
      )
      .padding(.top, -20)
      .ignoresSafeArea(edges: .bottom)
      .allowsHitTesting(false)
    }
  }

  /// The chat composer's field: glass capsule, faint prompt, blue caret, 36 × 28 arrow pill.
  private var field: some View {
    TextField(
      "", text: $model.text,
      prompt: Text(model.prompt).foregroundStyle(NativePalette.chatFaint), axis: .vertical
    )
    .font(.body).lineLimit(1...6).tint(NativePalette.chatInsertion)
    .padding(.leading, 16).padding(.trailing, 48)
    .padding(.vertical, model.text.contains("\n") ? 7 : 11)
    .frame(minHeight: 44)
    .overlay(alignment: .bottomTrailing) { sendButton.padding(.trailing, 5) }
    .nativeChatGlass(regularInLightMode: true)
    .accessibilityIdentifier("share.message")
  }

  private var sendButton: some View {
    let active = model.canSend || model.sending
    return Button { Task { await model.send() } } label: {
      ZStack {
        Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold)).opacity(model.sending ? 0 : 1)
        // The orb sits on the filled send button, so it takes the opposite scheme.
        if model.sending {
          ZStack { ThinkingOrb(state: .composing, size: .px20, theme: colorScheme == .dark ? .light : .dark, displaySize: 16) }
            .accessibilityElement(children: .ignore).accessibilityLabel("Sending")
        }
      }
      .foregroundStyle(active ? NativePalette.onPrimary : NativePalette.chatMuted)
      .frame(width: 36, height: 28)
      .background(
        active ? NativePalette.text : Color(red: 118 / 255, green: 118 / 255, blue: 128 / 255).opacity(0.24),
        in: Capsule())
      .frame(width: 44, height: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(SendButtonStyle())
    .disabled(!model.canSend)
    .animation(.easeOut(duration: 0.15), value: active)
    .accessibilityLabel(model.sendLabel)
    .accessibilityIdentifier("share.send")
  }
}

struct SendButtonStyle: ButtonStyle {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.opacity(configuration.isPressed ? 0.75 : 1)
      .animation(reduceMotion || configuration.isPressed ? nil : .easeOut(duration: 0.08), value: configuration.isPressed)
  }
}

/// Monochrome like the app's chrome: an outlined ring that fills black (white in dark mode).
struct SelectionMark: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var selected: Bool

  var body: some View {
    ZStack {
      Circle().strokeBorder(NativePalette.faint, lineWidth: 1.5).opacity(selected ? 0 : 1)
      Circle().fill(NativePalette.text).scaleEffect(selected ? 1 : 0.4).opacity(selected ? 1 : 0)
      Image(systemName: "checkmark").font(.system(size: 11, weight: .bold))
        .foregroundStyle(NativePalette.onPrimary).opacity(selected ? 1 : 0)
    }
    .frame(width: 24, height: 24)
    .animation(reduceMotion ? nil : .spring(duration: 0.25, bounce: 0.35), value: selected)
    .accessibilityHidden(true)
  }
}

/// An uploaded photo in a circle like the app, otherwise the Bot's robot, or two members
/// overlapping for a group without a photo.
struct ShareAvatar: View {
  var photo: UIImage?
  var robots: [UIImage]

  var body: some View {
    if let photo {
      Image(uiImage: photo).resizable().scaledToFill().clipShape(Circle())
    } else if robots.count > 1 {
      ZStack {
        Image(uiImage: robots[0]).resizable().scaledToFit()
          .frame(width: 30, height: 30)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        Image(uiImage: robots[1]).resizable().scaledToFit()
          .frame(width: 30, height: 30)
          .background(Circle().fill(NativePalette.background).padding(-2))
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
      }
    } else if let robot = robots.first {
      Image(uiImage: robot).resizable().scaledToFit()
    } else {
      Image(systemName: "person.2.circle.fill").resizable().foregroundStyle(NativePalette.muted)
    }
  }
}

/// Matches the app's file attachments: icon tile, name with a faint extension, faint size.
struct AttachmentChip: View {
  var file: SharedFile
  var remove: () -> Void

  var body: some View {
    Group {
      if file.isVisual || file.type.conforms(to: .pdf), let thumbnail = file.thumbnail {
        Image(uiImage: thumbnail).resizable().scaledToFill()
          .frame(width: 64, height: 64)
          .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
          .overlay {
            // White pages and screenshots would otherwise vanish against the canvas.
            RoundedRectangle(cornerRadius: 16, style: .continuous)
              .strokeBorder(NativePalette.separator, lineWidth: 1)
          }
          .overlay {
            if file.type.conforms(to: .movie) {
              Image(systemName: "play.fill").font(.callout).foregroundStyle(.white).shadow(radius: 2)
            }
          }
          .overlay(alignment: .bottom) {
            if let problem = file.problem {
              Text(problem).font(.caption2).foregroundStyle(.white).padding(2)
                .background(NativePalette.destructive)
            }
          }
      } else {
        HStack(spacing: 10) {
          Image(systemName: file.symbol)
            .font(.system(size: 16)).foregroundStyle(NativePalette.muted)
            .frame(width: 28, height: 28)
            .background(NativePalette.selection, in: RoundedRectangle(cornerRadius: 9))
          VStack(alignment: .leading, spacing: 3) {
            (Text(file.url.deletingPathExtension().lastPathComponent)
              + Text(file.url.pathExtension.isEmpty ? "" : "." + file.url.pathExtension)
                .foregroundStyle(NativePalette.faint))
              .font(.system(size: 16, weight: .medium)).lineLimit(1).truncationMode(.middle)
            Text(file.problem ?? ByteCountFormatter.string(fromByteCount: Int64(file.byteSize), countStyle: .file))
              .font(.system(size: 12))
              .foregroundStyle(file.problem == nil ? NativePalette.faint : NativePalette.destructive)
          }
        }
        .padding(.horizontal, 13).padding(.vertical, 10)
        .frame(maxWidth: 240, alignment: .leading)
        .background(NativePalette.assistant, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
      }
    }
    .overlay(alignment: .topTrailing) {
      Button(action: remove) {
        Image(systemName: "xmark")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(NativePalette.onPrimary)
          .frame(width: 20, height: 20)
          .background(NativePalette.text, in: Circle())
          .frame(width: 32, height: 32)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .offset(x: 12, y: -12)
      .accessibilityLabel("Remove \(file.fileName)")
    }
    .accessibilityElement(children: .contain)
  }
}
