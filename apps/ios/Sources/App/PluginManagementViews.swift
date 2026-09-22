import SwiftUI
import UniformTypeIdentifiers

struct PluginManagementView: View {
  @Environment(AppStore.self) private var store
  @State private var data: JSON = .null
  @State private var operation = FormOperation()
  var body: some View {
    NativeList {
      FormStatus(operation: operation)
      Section("Sources") {
        ForEach(data["sources"].array, id: \.self) { source in
          NavigationLink {
            PluginSourceEditor(source: source)
          } label: {
            VStack(alignment: .leading) {
              Text(source["name"].string)
              Text(source["error"].string.isEmpty ? source["url"].string : source["error"].string)
                .font(.caption).foregroundStyle(NativePalette.muted)
            }
          }
        }
        NavigationLink("Add source") { PluginSourceEditor(source: .null) }
      }
      Section("Private skills") {
        ForEach(data["skills"].array, id: \.self) { skill in
          NavigationLink(skill["name"].string) { PrivateSkillEditor(skill: skill) }
        }
        NavigationLink("Create skill") { PrivateSkillEditor(skill: .null) }
        Button("Sync skills", systemImage: "arrow.triangle.2.circlepath") {
          Task {
            await operation.run(success: "Skills synced.") {
              _ = try await store.request("/api/v0/plugins/sync", method: "POST")
            }
          }
        }
      }
      Section("Packages") {
        ForEach(data["drafts"].array, id: \.self) { draft in
          NavigationLink(draft["name"].string) { PluginDraftEditor(draft: draft) }
        }
        NavigationLink("Import package") {
          PluginImportView()
        }
      }
      Section { NavigationLink("Add custom MCP") { CustomMCPView() } }
    }.navigationTitle("Plugin workspace").navigationBarTitleDisplayMode(.inline)
      .task { await load() }.refreshable { await load() }.disabled(operation.busy)
  }
  private func load() async {
    await operation.run(feedback: false) {
      data = try await store.request("/api/v0/plugin-management")
    }
  }
}

struct PluginSourceEditor: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  let source: JSON
  @State private var name = ""
  @State private var url = ""
  @State private var operation = FormOperation()
  @State private var deleting = false
  private var path: String {
    "/api/v0/plugin-sources" + (source == .null ? "" : "/" + API.segment(source["id"].string))
  }
  var body: some View {
    NativeForm {
      Section("Source") {
        TextField("Name", text: $name)
        TextField("https://…", text: $url).keyboardType(.URL).textInputAutocapitalization(.never)
          .autocorrectionDisabled()
      }
      Section { FormStatus(operation: operation) }
      if source != .null {
        Section {
          Button("Refresh source") {
            Task {
              await operation.run(success: "Source refreshed.") {
                _ = try await store.request(path + "/refresh", method: "POST")
              }
            }
          }
          Button("Remove source", role: .destructive) { deleting = true }
        }
      }
    }.navigationTitle(source == .null ? "New source" : "Source").navigationBarTitleDisplayMode(
      .inline
    )
    .disabled(operation.busy).toolbar {
      Button("Save") {
        Task {
          if await operation.run({
            guard let address = URL(string: url), ["http", "https"].contains(address.scheme),
              address.host != nil
            else { throw APIError("Enter a valid HTTP or HTTPS source address.") }
            _ = try await store.request(
              path, method: source == .null ? "POST" : "PUT",
              body: .object(["url": .string(url), "name": .string(name)]))
          }) {
            dismiss()
          }
        }
      }.disabled(url.isEmpty || operation.busy)
    }.onAppear {
      name = source["name"].string
      url = source["url"].string
    }
    .confirmationDialog("Remove this source?", isPresented: $deleting, titleVisibility: .visible) {
      Button("Remove", role: .destructive) {
        Task {
          if await operation.run({ _ = try await store.request(path, method: "DELETE") }) {
            dismiss()
          }
        }
      }
    }
  }
}

struct PrivateSkillEditor: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  let skill: JSON
  @State private var name = ""
  @State private var description = ""
  @State private var bodyText = ""
  @State private var files = "{}"
  @State private var enabled: Set<String> = []
  @State private var operation = FormOperation()
  @State private var deleting = false
  private var path: String {
    "/api/v0/plugin-skills" + (skill == .null ? "" : "/" + API.segment(skill["id"].string))
  }
  var body: some View {
    NativeForm {
      Section { FormStatus(operation: operation) }
      Section("Skill") {
        TextField("Name", text: $name)
        TextField("Description", text: $description, axis: .vertical)
      }
      Section("Instructions") {
        TextEditor(text: $bodyText).frame(minHeight: 180).accessibilityIdentifier("skill-body")
      }
      Section("Enabled bots") {
        ForEach(store.bots) { bot in
          Toggle(
            bot.name,
            isOn: Binding(
              get: { enabled.contains(bot.id) },
              set: { if $0 { enabled.insert(bot.id) } else { enabled.remove(bot.id) } }))
        }
      }
      Section {
        DisclosureGroup("Supporting files") {
          JSONTextEditor(text: $files, label: "File paths and text contents")
        }
      }
      if skill != .null { Button("Delete skill", role: .destructive) { deleting = true } }
    }.navigationTitle(skill == .null ? "New skill" : "Edit skill").navigationBarTitleDisplayMode(
      .inline
    )
    .disabled(operation.busy).toolbar {
      Button("Save") {
        Task {
          if await operation.run({
            let fileMap = try FormValidation.stringMap(files, label: "Supporting files")
            _ = try await store.request(
              path, method: skill == .null ? "POST" : "PUT",
              body: .object([
                "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
                "description": .string(description), "body": .string(bodyText), "files": fileMap,
                "enabledBotIds": .array(enabled.sorted().map(JSON.string)),
              ]))
          }) {
            dismiss()
          }
        }
      }.disabled(
        name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 200
          || description.count > 2000 || operation.busy)
    }
    .onAppear {
      name = skill["name"].string
      description = skill["description"].string
      bodyText = skill["body"].string
      files = skill["files"] == .null ? "{}" : skill["files"].pretty
      enabled = Set(skill["enabledBotIds"].array.map(\.string))
    }
    .confirmationDialog(
      "Delete this private skill?", isPresented: $deleting, titleVisibility: .visible
    ) {
      Button("Delete", role: .destructive) {
        Task {
          if await operation.run({ _ = try await store.request(path, method: "DELETE") }) {
            dismiss()
          }
        }
      }
    }
  }
}

struct JSONTextEditor: View {
  @Binding var text: String
  let label: String
  var body: some View {
    VStack(alignment: .leading) {
      Text(label).font(.caption).foregroundStyle(NativePalette.muted)
      TextEditor(text: $text).font(.system(.body, design: .monospaced)).textInputAutocapitalization(
        .never
      ).keyboardType(.asciiCapable).autocorrectionDisabled().frame(minHeight: 150)
    }
  }
}

struct PluginImportView: View {
  @Environment(AppStore.self) private var store
  @State private var url = ""
  @State private var files = "{}"
  @State private var filePicker = false
  @State private var draft: JSON?
  @State private var operation = FormOperation()
  var body: some View {
    NativeForm {
      Section("From a URL") {
        TextField("Package URL", text: $url).keyboardType(.URL).textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        Button("Import URL") {
          Task {
            await operation.run {
              draft = try await store.request(
                "/api/v0/plugin-drafts/url", method: "POST", body: .object(["url": .string(url)]))
            }
          }
        }.disabled(url.isEmpty)
      }
      Section { Button("Import ZIP archive", systemImage: "doc.zipper") { filePicker = true } }
      Section {
        DisclosureGroup("Import text files") {
          JSONTextEditor(text: $files, label: "File paths and text contents")
          Button("Create draft") {
            Task {
              await operation.run {
                draft = try await store.request(
                  "/api/v0/plugin-drafts/import", method: "POST",
                  body: .object(["files": try FormValidation.stringMap(files, label: "Files")]))
              }
            }
          }
        }
      }
      Section { FormStatus(operation: operation) }
    }.navigationTitle("Import package").disabled(operation.busy)
      .navigationDestination(
        isPresented: Binding(get: { draft != nil }, set: { if !$0 { draft = nil } })
      ) { if let draft { PluginDraftEditor(draft: draft) } }
      .fileImporter(isPresented: $filePicker, allowedContentTypes: [.zip]) { result in
        Task {
          await operation.run {
            let url = try result.get()
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let api = store.api else { throw APIError("Sign in to import a package.") }
            let bytes = try Data(contentsOf: url)
            guard bytes.count <= 20 * 1024 * 1024 else {
              throw APIError("Choose a ZIP archive no larger than 20 MB.")
            }
            let (data, _) = try await api.raw(
              "/api/v0/plugin-drafts/archive", method: "POST", data: bytes,
              contentType: "application/zip")
            draft = try JSONDecoder().decode(JSON.self, from: data)
          }
        }
      }
  }
}

struct PluginDraftEditor: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  let draft: JSON
  @State private var definition = "{}"
  @State private var operation = FormOperation()
  @State private var deleting = false
  @State private var exported: URL?
  private var path: String { "/api/v0/plugin-drafts/" + API.segment(draft["id"].string) }
  var body: some View {
    NativeForm {
      Section("Definition") { JSONTextEditor(text: $definition, label: "Plugin package") }
      Section { FormStatus(operation: operation) }
      Section {
        Button("Save draft") {
          Task { await operation.run(success: "Draft saved.") { try await save() } }
        }
        Button("Install draft") {
          Task {
            if await operation.run({
              try await save()
              _ = try await store.request(path + "/install", method: "POST")
            }) {
              dismiss()
            }
          }
        }
        Button("Export package") {
          Task {
            await operation.run { exported = try await exportPlugin(path: path, store: store) }
          }
        }
        if let exported { ShareLink("Share package", item: exported) }
        Button("Delete draft", role: .destructive) { deleting = true }
      }
    }.navigationTitle(draft["name"].string).navigationBarTitleDisplayMode(.inline).disabled(
      operation.busy
    )
    .onAppear { definition = draft["definition"].pretty }
    .confirmationDialog("Delete this draft?", isPresented: $deleting, titleVisibility: .visible) {
      Button("Delete", role: .destructive) {
        Task {
          if await operation.run({ _ = try await store.request(path, method: "DELETE") }) {
            dismiss()
          }
        }
      }
    }
  }
  private func save() async throws {
    _ = try await store.request(
      path, method: "PUT",
      body: .object(["definition": try FormValidation.json(definition, label: "Definition")]))
  }
}

@MainActor private func exportPlugin(path: String, store: AppStore) async throws -> URL {
  let result = try await store.request(path + "/export")
  guard let bytes = Data(base64Encoded: result["base64"].string) else {
    throw APIError("The server did not return a valid package archive.")
  }
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let name = URL(fileURLWithPath: result["filename"].string).lastPathComponent
  let url = directory.appendingPathComponent(name.isEmpty ? "plugin.zip" : name)
  try bytes.write(to: url, options: [.atomic, .completeFileProtection])
  return url
}

struct InstalledPackageView: View {
  @Environment(AppStore.self) private var store
  let key: String
  @State private var data: JSON = .null
  @State private var operation = FormOperation()
  @State private var exported: URL?
  private var path: String { "/api/v0/plugins/" + API.segment(key) }
  var body: some View {
    NativeForm {
      FormStatus(operation: operation)
      Section("Installation") {
        Picker(
          "Mode",
          selection: Binding(
            get: { data["mode"].string },
            set: { mode in
              guard mode != data["mode"].string else { return }
              NativeHaptics.play(.selection, source: "plugin.mode")
              Task {
                await operation.run(successEffect: nil) {
                  _ = try await store.request(
                    path + "/mode", method: "POST", body: .object(["mode": .string(mode)]))
                  try await load()
                }
              }
            })
        ) {
          ForEach(["optional", "default", "required", "disabled"], id: \.self) {
            Text($0.capitalized).tag($0)
          }
        }
        LabeledContent("Skill sync", value: data["skillSyncStatus"].string)
        if !data["skillSyncError"].string.isEmpty {
          Text(data["skillSyncError"].string).foregroundStyle(NativePalette.destructive)
        }
      }
      if data["update"] != .null {
        Section("Update available") {
          ForEach(data["update"]["changes"].array, id: \.self) { Text($0.string) }
          Button("Install update") {
            Task {
              await operation.run(success: "Plugin updated.") {
                _ = try await store.request(
                  path + "/update", method: "POST",
                  body: .object(["digest": data["update"]["digest"]]))
                try await load()
              }
            }
          }
        }
      }
      if data["hasRollback"].bool {
        Button("Roll back to previous version") {
          Task {
            await operation.run {
              _ = try await store.request(path + "/rollback", method: "POST")
              try await load()
            }
          }
        }
      }
      Button("Export package") {
        Task { await operation.run { exported = try await exportPlugin(path: path, store: store) } }
      }
      if let exported { ShareLink("Share package", item: exported) }
    }.navigationTitle("Package").disabled(operation.busy).task {
      await operation.run(feedback: false) { try await load() }
    }
  }
  private func load() async throws { data = try await store.request(path + "/package") }
}

struct CustomMCPView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var endpoint = ""
  @State private var command = ""
  @State private var args = "[]"
  @State private var cwd = ""
  @State private var alias = ""
  @State private var headers = "{}"
  @State private var env = "{}"
  @State private var transport = "http"
  @State private var auth = "none"
  @State private var operation = FormOperation()
  var body: some View {
    NativeForm {
      Section("Connection") {
        TextField("Name", text: $name)
        TextField("Account alias (optional)", text: $alias)
        Picker("Transport", selection: $transport.hapticSelection("plugin.transport")) {
          Text("HTTP").tag("http")
          Text("Standard I/O").tag("stdio")
        }
        if transport == "http" {
          TextField("https://…", text: $endpoint).keyboardType(.URL).textInputAutocapitalization(
            .never
          ).autocorrectionDisabled()
          Picker("Authentication", selection: $auth.hapticSelection("plugin.authentication")) {
            Text("None").tag("none")
            Text("Token").tag("token")
            Text("OAuth").tag("oauth")
          }
        } else {
          TextField("Command", text: $command).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          TextField("Working directory (optional)", text: $cwd).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          JSONTextEditor(text: $args, label: "Arguments")
        }
      }
      Section {
        DisclosureGroup("Advanced") {
          JSONTextEditor(
            text: transport == "http" ? $headers : $env,
            label: transport == "http" ? "Headers" : "Environment")
        }
      }
      Section { FormStatus(operation: operation) }
    }.navigationTitle("Custom MCP").disabled(operation.busy).toolbar {
      Button("Add") {
        Task {
          if await operation.run({
            var body: [String: JSON] = ["name": .string(name), "auth": .string(auth)]
            if !alias.isEmpty { body["alias"] = .string(alias) }
            if transport == "http" {
              body["url"] = .string(try FormValidation.endpoint(endpoint))
              body["headers"] = try FormValidation.stringMap(headers, label: "Headers")
            } else {
              let arguments = try FormValidation.json(args, label: "Arguments", object: false)
              guard
                arguments.array.allSatisfy({
                  if case .string = $0 { return true }
                  return false
                })
              else { throw APIError("Each argument must be text.") }
              body["command"] = .string(command)
              body["args"] = arguments
              body["cwd"] = .string(cwd)
              body["env"] = try FormValidation.stringMap(env, label: "Environment")
            }
            _ = try await store.request(
              "/api/v0/plugins/custom-mcp", method: "POST", body: .object(body))
          }) {
            dismiss()
          }
        }
      }.disabled(
        name.count < 2 || operation.busy
          || (transport == "http" ? endpoint.isEmpty : command.isEmpty))
    }.onDisappear {
      headers = "{}"
      env = "{}"
    }
  }
}
