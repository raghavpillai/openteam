import SwiftUI

struct PluginListView: View {
  @Environment(AppStore.self) private var store
  @State private var settings: JSON = .null
  @State private var query = ""
  @State private var category = "All"
  // Keep aligned with client-core/plugin-marketplace.ts.
  private let categories = [
    "All", "Featured", "Team plugins", "Agent Orchestration", "Canvas",
    "Customer Support", "Data & Analytics", "Design", "Documents and Files", "Finance and Legal",
    "Inbox and Collaboration", "Infrastructure", "MCP", "Payments", "Productivity", "Research",
    "Sales", "Scheduling",
  ]
  @State private var failure: String?
  @State private var loading = true
  var body: some View {
    NativeList {
      if loading { ProgressView("Loading plugins…") }
      if let failure {
        Text(failure).foregroundStyle(NativePalette.destructive)
        Button("Retry") { Task { await load() } }
      }
      Section("Installed") {
        ForEach(filtered(settings["installs"].array).map { $0["pluginKey"].string }, id: \.self) {
          key in
          let plugin = settings["installs"].array.first { $0["pluginKey"].string == key } ?? .null
          NavigationLink {
            PluginDetailView(plugin: plugin, installed: true, onChange: load)
          } label: {
            pluginRow(plugin)
          }
        }
      }
      Section("Discover") {
        if !loading, failure == nil,
          filtered(settings["catalog"].array.filter { !$0["installed"].bool }, usingCategory: true)
            .isEmpty
        {
          Text("No plugins match this filter.").foregroundStyle(NativePalette.muted)
        }
        ForEach(
          filtered(settings["catalog"].array.filter { !$0["installed"].bool }, usingCategory: true),
          id: \.self
        ) {
          plugin in
          NavigationLink {
            PluginDetailView(plugin: plugin, installed: false, onChange: load)
          } label: {
            pluginRow(plugin)
          }
        }
      }
      Section {
        NavigationLink("Plugin workspace") {
          PluginManagementView()
        }
      }
      if !loading, failure == nil, settings["catalog"].array.isEmpty,
        settings["installs"].array.isEmpty
      {
        ContentUnavailableView(
          "No plugins available", systemImage: "puzzlepiece.extension",
          description: Text("Add a source or import a package in the plugin workspace."))
      }
    }.navigationTitle("Plugins").searchable(text: $query, prompt: "Search plugins").task {
      await load()
    }.refreshable { await load() }
      .toolbar {
        Menu {
          Picker("Filter plugins", selection: $category.hapticSelection("plugin.category")) {
            ForEach(categories, id: \.self) { Text($0).tag($0) }
          }
        } label: {
          Image(systemName: "line.3.horizontal.decrease")
        }.accessibilityLabel("Filter plugins: " + category).accessibilityIdentifier(
          "plugin-category")
      }
  }
  func filtered(_ values: [JSON], usingCategory: Bool = false) -> [JSON] {
    values.filter { plugin in
      let textMatches =
        query.isEmpty
        || ["name", "description", "publisher", "category"].contains {
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
    value.lowercased()
      .replacingOccurrences(of: #"\s*(?:&|\band\b)\s*"#, with: " ", options: .regularExpression)
      .split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }
  func pluginRow(_ plugin: JSON) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(plugin["name"].string).font(.headline)
      Text(plugin["description"].string).font(.subheadline).foregroundStyle(NativePalette.muted)
        .lineLimit(3)
    }.padding(.vertical, 5)
  }
  func load() async {
    loading = true
    do {
      settings = try await store.request("/api/v0/plugins")
      failure = nil
    } catch { failure = UserFacingError.message(error) }
    loading = false
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
      let needsSetup = !plugin["setupFields"].array.isEmpty
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
