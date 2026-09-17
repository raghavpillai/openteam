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
        ForEach(filtered(settings["installs"].array), id: \.self) { plugin in
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
  @Environment(\.openURL) private var openURL
  @State var plugin: JSON
  let installed: Bool
  let onChange: () async -> Void
  @State private var access: JSON = .null
  @State private var removal = false
  @State private var setup: [String: JSON] = [:]
  @State private var operation = FormOperation()
  @State private var botQuery = ""
  private var key: String { installed ? plugin["pluginKey"].string : plugin["key"].string }
  var body: some View {
    NativeForm {
      FormStatus(operation: operation)
      Section {
        Text(plugin["description"].string)
        LabeledContent("Publisher", value: plugin["publisher"].string)
        LabeledContent("Version", value: plugin["version"].string)
      }
      if installed {
        ForEach(plugin["connections"].array, id: \.self) { connection in
          Section(connection["name"].string) {
            LabeledContent(
              "Status",
              value: connection["status"].string.replacingOccurrences(of: "_", with: " ")
                .capitalized)
            if !connection["statusMessage"].string.isEmpty {
              Text(connection["statusMessage"].string).font(.caption).foregroundStyle(
                NativePalette.muted)
            }
            NavigationLink("Connection settings") { PluginConnectionView(connection: connection) }
            Button("Connect") {
              Task {
                await store.mutate(
                  "/api/v0/plugin-connections/\(API.segment(connection["id"].string))/connect",
                  successFeedback: .success, feedbackSource: "plugin.connect")
                await reload()
              }
            }
            if connection["canAuthenticate"].bool {
              Button("Sign in") {
                Task {
                  if let result = await store.mutate(
                    "/api/v0/plugin-connections/\(API.segment(connection["id"].string))/authenticate",
                    body: .object(["force": .bool(false)])),
                    let url = URL(string: result["authorizationUrl"].string),
                    ["https", "http"].contains(url.scheme)
                  {
                    openURL(url)
                  }
                }
              }
            }
            Button("Disconnect") {
              Task {
                await store.mutate(
                  "/api/v0/plugin-connections/\(API.segment(connection["id"].string))/disconnect",
                  successFeedback: .success, feedbackSource: "plugin.disconnect")
                await reload()
              }
            }
          }
        }
        Section("Bot access") {
          TextField("Search bots", text: $botQuery).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          ForEach(access["bots"].array, id: \.self) { bot in
            Toggle(
              bot["name"].string,
              isOn: Binding(
                get: { bot["skillsEnabled"].bool || !bot["grantedConnectionIds"].array.isEmpty },
                set: { value in
                  Task {
                    await store.mutate(
                      "/api/v0/plugins/\(API.segment(key))/enablement",
                      body: .object([
                        "botId": bot["id"], "enabled": .bool(value), "skillsEnabled": .bool(value),
                      ]))
                    await loadAccess()
                  }
                }))
          }
          if access["bots"].array.count < access["total"].int {
            Button("Load more bots") { Task { await loadAccess(more: true) } }
          }
        }
        Section { NavigationLink("Package and updates") { InstalledPackageView(key: key) } }
        Section { Button("Uninstall plugin", role: .destructive) { removal = true } }
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
        Button("Install plugin") {
          Task {
            if await operation.run({
              try FormValidation.fields(plugin["setupFields"].array, values: setup)
              _ = try await store.request(
                "/api/v0/plugins/install", method: "POST",
                body: .object(["pluginKey": .string(key), "values": .object(setup)]))
            }) {
              setup = [:]
              await onChange()
              dismiss()
            }
          }
        }.disabled(operation.busy)
      }
    }.navigationTitle(plugin["name"].string).navigationBarTitleDisplayMode(.inline)
      .task { if installed { await loadAccess() } }
      .task(id: botQuery) {
        guard installed else { return }
        do {
          try await Task.sleep(for: .milliseconds(250))
          await loadAccess()
        } catch {}
      }
      .onDisappear { setup = [:] }
      .confirmationDialog(
        "Uninstall \(plugin["name"].string)?", isPresented: $removal, titleVisibility: .visible
      ) {
        Button("Uninstall", role: .destructive) {
          Task {
            if await store.mutate(
              "/api/v0/plugins/\(API.segment(key))", method: "DELETE", successFeedback: .success,
              feedbackSource: "plugin.uninstall") != nil
            {
              await onChange()
              dismiss()
            }
          }
        }
      }
  }
  func reload() async {
    await onChange()
    do {
      let root = try await store.request("/api/v0/plugins")
      if let latest = root["installs"].array.first(where: { $0["pluginKey"].string == key }) {
        plugin = latest
      }
    } catch { operation.failure = UserFacingError.message(error) }
  }
  func loadAccess(more: Bool = false) async {
    do {
      var next = try await store.request(
        "/api/v0/plugins/\(API.segment(key))/bot-access",
        query: [
          "limit": "100", "offset": String(more ? access["bots"].array.count : 0), "q": botQuery,
        ])
      if more { next["bots"] = .array(access["bots"].array + next["bots"].array) }
      access = next
    } catch {
      if !UserFacingError.isCancelled(error) { operation.failure = UserFacingError.message(error) }
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
