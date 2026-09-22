import SwiftUI

struct PluginListView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var settings: JSON = .null
  @State private var query = ""
  @State private var category = "All"
  @State private var selected: JSON?
  @State private var installedOnly = false
  // Keep aligned with client-core/plugin-marketplace.ts.
  private let categories = [
    "All", "Featured", "Team plugins", "Agent Orchestration", "Canvas",
    "Customer Support", "Data & Analytics", "Design", "Documents and Files", "Finance and Legal",
    "Inbox and Collaboration", "Infrastructure", "MCP", "Payments", "Productivity", "Research",
    "Sales", "Scheduling",
  ]
  @State private var failure: String?
  @State private var loading = true
  private func key(_ plugin: JSON) -> String {
    plugin["pluginKey"].string.isEmpty ? plugin["key"].string : plugin["pluginKey"].string
  }
  private func installed(_ plugin: JSON) -> JSON? {
    settings["installs"].array.first { key($0) == key(plugin) }
  }
  private var groups: [(name: String, plugins: [JSON])] {
    if installedOnly { return [("Installed", filtered(settings["installs"].array))] }
    let catalog = settings["catalog"].array
    let extra = settings["installs"].array.filter { item in !catalog.contains { key($0) == key(item) } }
    let values = filtered(catalog + extra, usingCategory: true)
    if !query.isEmpty || category != "All" { return [(query.isEmpty ? category : "Results", values)] }
    var names: [String] = []
    for item in values where !item["featured"].bool {
      let name = item["category"].string.isEmpty ? "Team plugins" : item["category"].string
      if !names.contains(name) { names.append(name) }
    }
    return [("Featured", values.filter { $0["featured"].bool })]
      + names.map { name in (name, values.filter {
        !$0["featured"].bool && ($0["category"].string.isEmpty ? "Team plugins" : $0["category"].string) == name
      }) }
  }
  var body: some View {
    ScrollView {
      catalogContent
    }.nativeCanvas().scrollDismissesKeyboard(.interactively)
      .floatingBar(edge: .top) { searchBar }
      .overlay {
        if loading && settings == .null {
          ProgressView().accessibilityLabel("Loading plugins…")
            .accessibilityIdentifier("plugins-loading")
        }
      }
      .navigationTitle("Plugins").navigationBarTitleDisplayMode(.inline)
      .navigationBarBackButtonHidden()
      .navigationDestination(item: $selected) { plugin in
        PluginDetailView(plugin: plugin, installed: installed(plugin) != nil, onChange: load)
      }
      .toolbar { catalogToolbar }.task { await load() }.refreshable { await load() }
  }
  @ToolbarContentBuilder private var catalogToolbar: some ToolbarContent {

        ToolbarItem(placement: .principal) { Color.clear.frame(width: 1, height: 1) }
        if #available(iOS 26.0, *) {
          ToolbarItem(placement: .topBarLeading) { catalogHeading }
            .sharedBackgroundVisibility(.hidden)
        } else {
          ToolbarItem(placement: .topBarLeading) { catalogHeading }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button { installedOnly.toggle() } label: {
            HStack(spacing: 6) {
              if let first = settings["installs"].array.first {
                PluginCatalogMark(plugin: first, fallback: settings["catalog"].array.first { key($0) == key(first) }, size: 20)
              }
              Text("\(settings["installs"].array.count) installed").font(.system(size: 17))
            }
          }.accessibilityIdentifier("installed-plugins")
        }
        }
  private var catalogHeading: some View {
    HStack(spacing: 14) {
      ChromeButton(title: "Back", symbol: "chevron.left") {
        if installedOnly { installedOnly = false } else { dismiss() }
      }
      Text(installedOnly ? "Installed" : "Plugins")
        .font(.system(size: 17, weight: .medium)).fixedSize()
    }.fixedSize()
  }
  private var catalogContent: some View {
      LazyVStack(alignment: .leading, spacing: 0) {
        if let failure {
          VStack(alignment: .leading, spacing: 10) {
            InlineFailure(message: failure)
            Button("Retry") { Task { await load() } }
          }.padding(.vertical, 16)
        }
        ForEach(groups.indices, id: \.self) { index in
          let group = groups[index]
          if !group.plugins.isEmpty {
            HStack {
              Text(group.name).font(.system(size: 13)).foregroundStyle(NativePalette.faint)
              Spacer()
              if !installedOnly, query.isEmpty, category == "All" {
                Button("View all") { category = group.name }
                  .font(.system(size: 13)).foregroundStyle(NativePalette.muted)
              }
            }.padding(.horizontal, 4).padding(.top, 24).padding(.bottom, 8)
            ForEach(group.plugins, id: \.self) { plugin in
              pluginButton(plugin)
            }
          }
        }
        if !loading, failure == nil, groups.allSatisfy({ $0.plugins.isEmpty }) {
          Text(query.isEmpty && category == "All" ? "No plugins available." : "No plugins match this filter.")
            .foregroundStyle(NativePalette.muted).padding(.vertical, 24)
        }
        if !loading {
          NavigationLink("Plugin workspace") { PluginManagementView() }
            .foregroundStyle(NativePalette.link).padding(.vertical, 24)
        }
      }.padding(.horizontal, 20).padding(.bottom, 20)
  }
  private func pluginButton(_ plugin: JSON) -> some View {
    Button { selected = installed(plugin) ?? plugin } label: { pluginRow(plugin) }
      .buttonStyle(.plain).accessibilityElement(children: .combine)
      .accessibilityLabel(plugin["name"].string + ", " + plugin["description"].string)
  }
  private var searchBar: some View {
    HStack(spacing: 8) {
      HStack(spacing: 7) {
        Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(NativePalette.faint)
        TextField("Search plugins", text: $query).font(.system(size: 15))
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .tint(NativePalette.chatInsertion).accessibilityIdentifier("plugin-search")
        if !query.isEmpty {
          Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
            .foregroundStyle(NativePalette.muted).accessibilityLabel("Clear search")
        }
      }.padding(.horizontal, 12).frame(height: 40).nativeGlass()
      Menu {
        Picker("Filter plugins", selection: $category.hapticSelection("plugin.category")) {
          ForEach(categories, id: \.self) { Text($0).tag($0) }
        }
      } label: {
        Image(systemName: "line.3.horizontal.decrease").font(.system(size: 18))
          .frame(width: 42, height: 42).nativeGlass()
      }.accessibilityLabel("Filter plugins: " + category).accessibilityIdentifier("plugin-category")
    }.padding(.horizontal, 18).padding(.top, 2).padding(.bottom, 8)
  }
  func filtered(_ values: [JSON], usingCategory: Bool = false) -> [JSON] {
    values.filter { plugin in
      let textMatches = query.isEmpty || ["name", "description", "publisher", "category"].contains {
        plugin[$0].string.localizedCaseInsensitiveContains(query)
      }
      guard textMatches, usingCategory else { return textMatches }
      switch category {
      case "All": return true
      case "Featured": return plugin["featured"].bool
      case "Team plugins": return !plugin["featured"].bool
      case "MCP": return plugin["components"].array.contains(.string("mcp"))
      default: return normalizedCategory(plugin["category"].string) == normalizedCategory(category)
      }
    }
  }
  private func normalizedCategory(_ value: String) -> String {
    value.lowercased().replacingOccurrences(of: #"\s*(?:&|\band\b)\s*"#, with: " ", options: .regularExpression)
      .split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }
  private func actionLabel(_ plugin: JSON) -> String {
    guard let install = installed(plugin) else { return "Add" }
    if install["connections"].array.contains(where: {
      ["needs_auth", "unauthenticated", "expired", "error"].contains($0["status"].string)
    }) { return "Authorize" }
    return "Added"
  }
  private func pluginRow(_ plugin: JSON) -> some View {
    HStack(spacing: 16) {
      PluginCatalogMark(plugin: plugin, fallback: nil, size: 38)
      VStack(alignment: .leading, spacing: 3) {
        Text(plugin["name"].string).font(.system(size: 17)).foregroundStyle(NativePalette.text)
        Text(plugin["description"].string).font(.system(size: 14))
          .foregroundStyle(NativePalette.muted).lineLimit(2)
      }.frame(maxWidth: .infinity, alignment: .leading)
      let label = actionLabel(plugin)
      Text(label).font(.system(size: 14, weight: label == "Authorize" ? .medium : .regular))
        .foregroundStyle(label == "Authorize" ? Color.white : NativePalette.text)
        .padding(.horizontal, 13).frame(height: 32)
        .background(label == "Authorize" ? NativePalette.link : NativePalette.selection, in: Capsule())
        .accessibilityHidden(true)
    }.frame(minHeight: 72).contentShape(Rectangle())
  }
  func load() async {
    loading = true
    do { settings = try await store.request("/api/v0/plugins"); failure = nil }
    catch { failure = UserFacingError.message(error) }
    loading = false
  }
}

/// Package-owned PNG/JPEG icons arrive as data URLs and work without a network
/// request. External logos remain optional; unsupported/missing icons use a mark.
private struct PluginCatalogMark: View {
  let plugin: JSON
  let fallback: JSON?
  let size: CGFloat
  private var source: String {
    [plugin["logoUrl"].string, plugin["catalog"]["logoUrl"].string, fallback?["logoUrl"].string ?? ""]
      .first { !$0.isEmpty } ?? ""
  }
  var body: some View {
    Group {
      if source.hasPrefix("data:image/"), source.contains(";base64,"),
        let encoded = source.components(separatedBy: ";base64,").last, encoded.count <= 350_000,
        let data = Data(base64Encoded: encoded), let image = UIImage(data: data) {
        Image(uiImage: image).resizable().scaledToFit().background(.white)
      } else if let url = URL(string: source), ["https", "http"].contains(url.scheme ?? "") {
        AsyncImage(url: url) { image in image.resizable().scaledToFit() } placeholder: { placeholder }
      } else { placeholder }
    }.frame(width: size, height: size).clipShape(RoundedRectangle(cornerRadius: size * 0.2))
      .accessibilityHidden(true)
  }
  private var placeholder: some View {
    RoundedRectangle(cornerRadius: size * 0.2).fill(NativePalette.selection)
      .overlay { Image(systemName: "puzzlepiece.extension").font(.system(size: size * 0.58)).foregroundStyle(NativePalette.muted) }
  }
}

struct PluginDetailView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State var plugin: JSON
  let installed: Bool
  let onChange: () async -> Void
  @State private var newlyInstalled = false
  @State private var autoConnectID: String?
  @State private var access: JSON = .null
  @State private var accessFailure: String?
  @State private var accessLoading = false
  @State private var accessGeneration = UUID()
  @State private var removal = false
  @State private var setup: [String: JSON] = [:]
  @State private var operation = FormOperation()
  @State private var botQuery = ""
  @FocusState private var botSearchFocused: Bool
  private var isInstalled: Bool { installed || newlyInstalled }
  private var key: String {
    plugin["pluginKey"].string.isEmpty ? plugin["key"].string : plugin["pluginKey"].string
  }
  var body: some View {
    NativeForm {
      if !isInstalled { FormStatus(operation: operation) }
      Section {
        Text(plugin["description"].string)
        LabeledContent("Publisher", value: plugin["publisher"].string)
        LabeledContent("Version", value: plugin["version"].string)
      }
      let catalog = isInstalled ? plugin["catalog"] : plugin
      if !catalog["installationSteps"].array.isEmpty {
        Section("Installation steps") {
          ForEach(Array(catalog["installationSteps"].array.enumerated()), id: \.offset) { index, step in
            Text("\(index + 1). " + step.string)
          }
        }
      }
      if !isInstalled, !catalog["setup"]["title"].string.isEmpty {
        Section("Provider setup") {
          Text(catalog["setup"]["description"].string)
          ForEach(Array(catalog["setup"]["steps"].array.enumerated()), id: \.offset) { index, step in
            Text("\(index + 1). " + step.string)
          }
          if let url = URL(string: catalog["setup"]["documentationUrl"].string) { Link("Provider setup guide", destination: url) }
        }
      }
      if isInstalled {
        ForEach(plugin["connections"].array.map { $0["id"].string }, id: \.self) { id in
          let connection = connectionBinding(id)
          Section(connection.wrappedValue["name"].string) {
            NavigationLink("Connection settings") {
              PluginConnectionView(connection: connection.wrappedValue)
            }
            PluginConnectionActions(connection: connection, startAutomatically: autoConnectID == id)
          }
        }
        Section { NavigationLink("Package and updates") { InstalledPackageView(key: key) } }
        Section {
          FormStatus(operation: operation)
          Button("Uninstall plugin", role: .destructive) { removal = true }.disabled(operation.busy)
        }
        Section("Bot access") {
          TextField("Search bots", text: $botQuery).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .focused($botSearchFocused).submitLabel(.done).onSubmit { botSearchFocused = false }
          if let accessFailure {
            InlineFailure(message: accessFailure)
            Button("Retry bot access") { Task { await loadAccess() } }
          }
          if accessLoading { ProgressView("Loading bots…") }
          if !accessLoading, accessFailure == nil, access["bots"].array.isEmpty {
            Text(botQuery.isEmpty ? "No bots available." : "No bots match your search.")
              .foregroundStyle(NativePalette.muted)
          }
          ForEach(access["bots"].array.map { $0["id"].string }, id: \.self) { botID in
            let bot = access["bots"].array.first { $0["id"].string == botID } ?? .null
            Group {
              Toggle(
                "Enable for " + bot["name"].string,
                isOn: Binding(
                  get: { bot["skillsEnabled"].bool },
                  set: { value in Task { await setAccess(bot: bot, enabled: value) } }))
              ForEach(plugin["connections"].array, id: \.self) { account in
                Toggle(
                  "Allow "
                    + (account["alias"].string.isEmpty
                      ? account["name"].string : account["alias"].string),
                  isOn: Binding(
                    get: { bot["grantedConnectionIds"].array.contains(account["id"]) },
                    set: { value in
                      Task {
                        await setAccess(bot: bot, enabled: value, account: account["id"].string)
                      }
                    })
                )
                .font(.subheadline)
              }
            }.tint(NativePalette.toggle).disabled(operation.busy || accessLoading)
          }
          Text(
            "Enable the plugin and choose which accounts this bot may use. Account access is saved separately."
          )
          .font(.footnote).foregroundStyle(NativePalette.muted)
          if access["bots"].array.count < access["total"].int {
            Button("Load more bots") { Task { await loadAccess(more: true) } }.disabled(
              accessLoading)
          }
        }
      } else {
        if !plugin["setupFields"].array.isEmpty {
          Section("Setup") {
            ForEach(plugin["setupFields"].array, id: \.self) { field in
              let id = field["key"].string.isEmpty ? field["id"].string : field["key"].string
              PluginFieldInput(
                field: field,
                value: Binding(get: { setup[id] ?? field["default"] }, set: { setup[id] = $0 }))
            }
          }
        }
        Button("Install plugin") { Task { await install() } }.disabled(operation.busy)
      }
    }.scrollDismissesKeyboard(.interactively).navigationTitle(plugin["name"].string)
      .navigationBarTitleDisplayMode(.inline)
      .task(id: botQuery) {
        guard isInstalled else { return }
        access = .null
        accessFailure = nil
        do {
          try await Task.sleep(for: .milliseconds(250))
          await loadAccess()
        } catch {}
      }
      .onDisappear { setup = [:] }
      .confirmationDialog(
        "Uninstall \(plugin["name"].string)?", isPresented: $removal, titleVisibility: .visible
      ) {
        Button("Uninstall", role: .destructive) { Task { await uninstall() } }
      }
  }
  private func connectionBinding(_ id: String) -> Binding<JSON> {
    Binding(
      get: { plugin["connections"].array.first(where: { $0["id"].string == id }) ?? .null },
      set: { value in
        plugin["connections"] = .array(
          plugin["connections"].array.map { $0["id"].string == id ? value : $0 })
      })
  }
  private func latestInstallation() async throws -> JSON? {
    let root = try await store.request("/api/v0/plugins")
    return root["installs"].array.first { $0["pluginKey"].string == key }
  }
  private func install() async {
    await operation.run(successEffect: nil) {
      try FormValidation.fields(plugin["setupFields"].array, values: setup)
      var responseError: Error?
      do {
        _ = try await store.request(
          "/api/v0/plugins/install", method: "POST",
          body: .object(["pluginKey": .string(key), "values": .object(setup)]))
      } catch { responseError = error }
      guard let latest = try await latestInstallation() else {
        throw responseError ?? APIError("Installation could not be confirmed. Try again.")
      }
      let needsSetup = !plugin["setupFields"].array.isEmpty || plugin["setup"]["kind"].string == "oauth_client"
      plugin = latest
      newlyInstalled = true
      setup = [:]
      // Retain the detail page and continue with the newly created account.
      if let account = latest["connections"].array.first,
        account["configured"].bool || (account["auth"].string == "oauth" && !needsSetup)
      {
        autoConnectID = account["id"].string
      }
      await loadAccess()
    }
  }
  private func uninstall() async {
    if await operation.run({
      var responseError: Error?
      do {
        _ = try await store.request("/api/v0/plugins/" + API.segment(key), method: "DELETE")
      } catch { responseError = error }
      // An acknowledged deletion and a lost response both reconcile against the server.
      guard try await latestInstallation() == nil else {
        throw responseError ?? APIError("The plugin is still installed. Try again.")
      }
    }) {
      dismiss()
      await onChange()
    }
  }
  private func setAccess(bot: JSON, enabled: Bool, account: String? = nil) async {
    await operation.run {
      let path =
        account.map { "/api/v0/plugin-connections/" + API.segment($0) + "/grant" }
        ?? "/api/v0/plugins/\(API.segment(key))/enablement"
      var body: [String: JSON] = ["botId": bot["id"], "enabled": .bool(enabled)]
      if account == nil { body["skillsEnabled"] = .bool(enabled) }
      var responseError: Error?
      do { _ = try await store.request(path, method: "POST", body: .object(body)) } catch {
        responseError = error
      }
      await loadAccess()
      guard let actual = access["bots"].array.first(where: { $0["id"] == bot["id"] }),
        accessFailure == nil
      else {
        throw responseError ?? APIError("Refresh bot access to confirm this change.")
      }
      let actualValue =
        account.map { actual["grantedConnectionIds"].array.contains(.string($0)) }
        ?? actual["skillsEnabled"].bool
      if actualValue != enabled {
        throw responseError ?? APIError("Access was not updated. Try again.")
      }
    }
  }
  private func loadAccess(more: Bool = false) async {
    let token = UUID()
    let query = botQuery
    accessGeneration = token
    accessLoading = true
    defer { if accessGeneration == token { accessLoading = false } }
    do {
      var next = try await store.request(
        "/api/v0/plugins/\(API.segment(key))/bot-access",
        query: [
          "limit": "60", "offset": String(more ? access["bots"].array.count : 0), "q": query,
        ])
      try Task.checkCancellation()
      guard accessGeneration == token, query == botQuery else { return }
      if more { next["bots"] = .array(access["bots"].array + next["bots"].array) }
      access = next
      accessFailure = nil
    } catch {
      if accessGeneration == token, !UserFacingError.isCancelled(error) {
        accessFailure = UserFacingError.message(error)
      }
    }
  }
}

struct PluginFieldInput: View {
  let field: JSON
  @Binding var value: JSON
  private var text: Binding<String> {
    Binding(
      get: {
        switch value {
        case .number(let n):
          return n.isFinite && n.rounded() == n && n < Double(Int.max) && n >= Double(Int.min)
            ? String(Int(n)) : String(n)
        case .string(let s): return s
        default: return ""
        }
      },
      set: { raw in
        if ["number", "integer"].contains(field["type"].string), let number = Double(raw),
          number.isFinite
        {
          value = .number(number)
        } else {
          value = .string(raw)
        }
      })
  }
  var body: some View {
    if field["secret"].bool {
      SecureField(field["label"].string, text: text)
    } else if !field["enum"].array.isEmpty {
      Picker(field["label"].string, selection: $value.hapticSelection("plugin.field")) {
        Text("Choose…").tag(JSON.null)
        ForEach(field["enum"].array, id: \.self) { option in
          Text(option.string.isEmpty ? option.pretty : option.string).tag(option)
        }
      }
    } else if field["type"].string == "boolean" {
      Toggle(field["label"].string, isOn: Binding(get: { value.bool }, set: { value = .bool($0) }))
    } else {
      LabeledContent(field["label"].string) {
        TextField(field["label"].string, text: text).multilineTextAlignment(.trailing)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled().keyboardType(
            ["number", "integer"].contains(field["type"].string) ? .numbersAndPunctuation : .default
          )
      }
    }
  }
}
