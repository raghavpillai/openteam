import SwiftUI

struct PluginConnectionView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State var connection: JSON
  @State private var configuration: JSON = .null
  @State private var values: [String: JSON] = [:]
  @State private var secrets: [String: String] = [:]
  @State private var cleared: Set<String> = []
  @State private var instructions = ""
  @State private var alias = ""
  @State private var newAlias = ""
  @State private var endpoint = ""
  @State private var command = ""
  @State private var args = "[]"
  @State private var cwd = ""
  @State private var env = "{}"
  @State private var headers = "{}"
  @State private var clearHeaders = false
  @State private var clearEnvironment = false
  @State private var method = "none"
  @State private var callbackMode = "auto"
  @State private var operation = FormOperation()
  @State private var remove = false
  @State private var loaded = false
  var path: String { "/api/v0/plugin-connections/\(API.segment(connection["id"].string))" }
  var body: some View {
    NativeForm {
      Section {
        FormStatus(operation: operation)
        if !loaded, !operation.busy { Button("Retry") { Task { await load() } } }
      }
      if loaded {
        Section("Account") {
          TextField("Account alias", text: $alias)
          Button("Rename account") {
            perform(
              "/account", method: "PATCH", body: .object(["alias": .string(alias)]),
              success: "Account renamed.")
          }.disabled(alias.count < 2 || alias.count > 80)
          TextField("New account alias", text: $newAlias)
          Button("Add another account") {
            perform(
              "/accounts", body: .object(["alias": .string(newAlias)]), success: "Account added.")
          }.disabled(newAlias.count < 2 || newAlias.count > 80)
          Button("Remove account", role: .destructive) { remove = true }
        }
        if !configuration["setup"]["title"].string.isEmpty {
          Section("Provider setup") {
            Text(configuration["setup"]["title"].string).font(.headline)
            Text(configuration["setup"]["description"].string)
            ForEach(Array(configuration["setup"]["steps"].array.enumerated()), id: \.offset) { index, step in
              Text("\(index + 1). " + step.string)
            }
            if let url = URL(string: configuration["setup"]["documentationUrl"].string) {
              Link("Provider setup guide", destination: url)
            }
          }
        }
        Section("Configuration") {
          if connection["auth"].string == "oauth" {
            Picker("Sign-in method", selection: $callbackMode) {
              Text("Automatic (recommended)").tag("auto")
              Text("Paste callback URL").tag("manual")
              Text("Desktop listener (advanced)").tag("desktop")
              Text("Server callback").tag("server")
            }
            if callbackMode == "desktop" {
              Text("Connect once in the desktop app using a native OAuth client. Your server stores the connection and makes it available on this device.")
                .font(.footnote).foregroundStyle(NativePalette.muted)
            } else if callbackMode == "manual" || (callbackMode == "auto" && !configuration["callbackUrl"].string.hasPrefix("https://")) {
              if configuration["manualCallbackSupported"] == .bool(false) {
                Text("This provider requires HTTPS. Configure Tailscale Serve or your own HTTPS domain before authorizing.")
                  .font(.footnote).foregroundStyle(NativePalette.muted)
              } else {
                Text("Your server uses manual callback paste. For Google, create a Desktop app OAuth client. After approving access in your browser, copy the full callback address and paste it into OpenTeam. No desktop app is needed.")
                  .font(.footnote).foregroundStyle(NativePalette.muted)
                Text(configuration["manualCallbackUrl"].string).font(.footnote.monospaced()).textSelection(.enabled)
              }
            } else {
              Text("Register this exact callback with your provider’s web OAuth client. Google requires an HTTPS hostname for a remote server callback. A desktop OAuth client cannot be reused for this method.")
                .font(.footnote).foregroundStyle(NativePalette.muted)
              Text(configuration["callbackUrl"].string).font(.footnote.monospaced())
                .textSelection(.enabled)
            }
          }
          ForEach(configuration["fields"].array, id: \.self) { field in
            let id = field["key"].string
            if field["secret"].bool {
              SecureField(
                field["label"].string
                  + (configuration["configuredSecrets"].array.contains(.string(id))
                    ? " (saved)" : ""),
                text: Binding(
                  get: { secrets[id] ?? "" },
                  set: {
                    secrets[id] = $0
                    cleared.remove(id)
                  })
              )
              .textInputAutocapitalization(.never).autocorrectionDisabled()
              if configuration["configuredSecrets"].array.contains(.string(id)) {
                Toggle(
                  "Clear saved " + field["label"].string.lowercased(),
                  isOn: Binding(
                    get: { cleared.contains(id) },
                    set: {
                      if $0 {
                        cleared.insert(id)
                        secrets[id] = ""
                      } else {
                        cleared.remove(id)
                      }
                    }))
              }
            } else {
              PluginFieldInput(
                field: field,
                value: Binding(get: { values[id] ?? field["default"] }, set: { values[id] = $0 }))
            }
            if !field["helpText"].string.isEmpty {
              Text(field["helpText"].string).font(.footnote).foregroundStyle(NativePalette.muted)
            }
          }
          if connection["transport"].string == "http" {
            TextField("Endpoint", text: $endpoint).keyboardType(.URL).textInputAutocapitalization(
              .never
            ).autocorrectionDisabled()
          } else if connection["transport"].string == "stdio" {
            TextField("Command", text: $command).textInputAutocapitalization(.never)
              .autocorrectionDisabled()
            TextField("Working directory", text: $cwd).textInputAutocapitalization(.never)
              .autocorrectionDisabled()
            JSONTextEditor(text: $args, label: "Arguments")
          }
          DisclosureGroup("Advanced connection settings") {
            Picker(
              "OAuth client authentication",
              selection: $method.hapticSelection("plugin.authentication")
            ) {
              Text("None").tag("none")
              Text("Client secret in body").tag("client_secret_post")
              Text("HTTP Basic").tag("client_secret_basic")
            }
            JSONTextEditor(text: $headers, label: "Replacement headers")
              .disabled(clearHeaders)
            Text("Saved headers: " + configuration["headerNames"].array.map(\.string).joined(separator: ", "))
              .font(.footnote).foregroundStyle(NativePalette.muted)
            Toggle("Clear all saved headers", isOn: $clearHeaders)
              .accessibilityIdentifier("connection-clear-headers")
            JSONTextEditor(text: $env, label: "Replacement environment variables")
              .disabled(clearEnvironment)
            Text("Saved environment variables: " + configuration["environmentNames"].array.map(\.string).joined(separator: ", "))
              .font(.footnote).foregroundStyle(NativePalette.muted)
            Toggle("Clear all saved environment variables", isOn: $clearEnvironment)
              .accessibilityIdentifier("connection-clear-environment")
            Text(
              "Leave these objects empty to preserve saved values, or select Clear all to remove them when saving. Saved values are never displayed."
            ).font(.footnote).foregroundStyle(NativePalette.muted)
          }
          Button("Save configuration") { Task { await save() } }
        }
        Section("Instructions") {
          TextEditor(text: $instructions).frame(minHeight: 130)
          Button("Save instructions") {
            perform(
              "/instructions", method: "PATCH",
              body: .object(["instructions": .string(instructions)]), success: "Instructions saved."
            )
          }
        }
        Section {
          NavigationLink("Tool permissions") { PluginToolPoliciesView(connection: connection) }
          NavigationLink("Test a tool") { PluginToolTestView(connection: connection) }
          PluginConnectionActions(
            connection: $connection, beforeSignIn: { await save(feedback: false) })
          Button("Restart connection") { perform("/restart", success: "Connection restarted.") }
        }
      }
    }.navigationTitle("Connection").navigationBarTitleDisplayMode(.inline).disabled(operation.busy)
      .task { if !loaded { await load() } }
      .onDisappear {
        secrets = [:]
        env = "{}"
        headers = "{}"
      }
      .confirmationDialog("Remove this account?", isPresented: $remove, titleVisibility: .visible) {
        Button("Remove account", role: .destructive) {
          Task {
            if await operation.run({
              _ = try await store.request(path + "/account", method: "DELETE")
            }) {
              dismiss()
            }
          }
        }
      }
  }
  private func load() async {
    await operation.run(feedback: false) {
      configuration = try await store.request(path + "/configuration")
      values = configuration["values"].object
      instructions = connection["instructions"].string
      alias = connection["alias"].string
      endpoint = configuration["endpoint"].string
      command = configuration["command"].string
      args = configuration["args"].pretty
      cwd = configuration["cwd"].string
      method =
        configuration["tokenEndpointAuthMethod"].string.isEmpty
        ? "none" : configuration["tokenEndpointAuthMethod"].string
      callbackMode = configuration["oauthCallbackMode"].string.isEmpty ? "auto" : configuration["oauthCallbackMode"].string
      loaded = true
    }
  }
  private func perform(
    _ suffix: String, method: String = "POST", body: JSON? = nil, success: String
  ) {
    Task {
      await operation.run(success: success) {
        _ = try await store.request(path + suffix, method: method, body: body)
      }
    }
  }
  @discardableResult private func save(feedback: Bool = true) async -> Bool {
    await operation.run(success: "Configuration saved.", feedback: feedback) {
      var validation = values
      for (key, value) in secrets where !value.isEmpty { validation[key] = .string(value) }
      try FormValidation.fields(
        configuration["fields"].array.filter { !cleared.contains($0["key"].string) },
        values: validation,
        savedSecrets: configuration["configuredSecrets"].array.map(\.string).filter {
          !cleared.contains($0)
        })
      var actions = secrets.filter { !$0.value.isEmpty }.mapValues {
        JSON.object(["action": .string("replace"), "value": .string($0)])
      }
      for id in cleared { actions[id] = .object(["action": .string("clear")]) }
      var body: [String: JSON] = [
        "values": .object(values), "secrets": .object(actions),
        "tokenEndpointAuthMethod": .string(method),
      ]
      if connection["auth"].string == "oauth" { body["oauthCallbackMode"] = .string(callbackMode) }
      if connection["transport"].string == "http" {
        body["endpoint"] = .string(try FormValidation.endpoint(endpoint))
      }
      if connection["transport"].string == "stdio" {
        let parsed = try FormValidation.json(args, label: "Arguments", object: false)
        guard
          parsed.array.allSatisfy({
            if case .string = $0 { return true }
            return false
          })
        else { throw APIError("Each argument must be text.") }
        body["command"] = .string(command)
        body["args"] = parsed
        body["cwd"] = .string(cwd)
      }
      let headerMap = clearHeaders ? JSON.object([:]) : try FormValidation.stringMap(headers, label: "Headers")
      let environment = clearEnvironment ? JSON.object([:]) : try FormValidation.stringMap(env, label: "Environment")
      if clearHeaders || !headerMap.object.isEmpty { body["headers"] = headerMap }
      if clearEnvironment || !environment.object.isEmpty { body["env"] = environment }
      _ = try await store.request(path + "/configuration", method: "PUT", body: .object(body))
      secrets = [:]
      cleared = []
      headers = "{}"
      env = "{}"
      clearHeaders = false
      clearEnvironment = false
      configuration = try await store.request(path + "/configuration")
      if connection["auth"].string == "oauth" {
        connection["oauthCallbackMode"] = configuration["oauthCallbackMode"]
      }
    }
  }
}

struct PluginToolPoliciesView: View {
  @Environment(AppStore.self) private var store
  let connection: JSON
  @State private var data: JSON = .null
  @State private var botID = ""
  @State private var operation = FormOperation()
  var body: some View {
    NativeForm {
      FormStatus(operation: operation)
      Picker("Applies to", selection: $botID.hapticSelection("plugin.scope")) {
        Text("All bots").tag("")
        ForEach(store.bots) { Text($0.name).tag($0.id) }
      }
      ForEach(connection["tools"].array, id: \.self) { tool in
        Section(tool["name"].string) {
          Text(tool["description"].string).font(.subheadline).foregroundStyle(NativePalette.muted)
          Picker(
            "Permission",
            selection: Binding(
              get: {
                data["policies"].array.first {
                  $0["connectionId"] == connection["id"] && $0["toolName"] == tool["name"]
                    && $0["botId"].string == botID
                }?["decision"].string ?? tool["defaultDecision"].string
              },
              set: { decision in
                let current =
                  data["policies"].array.first {
                    $0["connectionId"] == connection["id"] && $0["toolName"] == tool["name"]
                      && $0["botId"].string == botID
                  }?["decision"].string ?? tool["defaultDecision"].string
                guard decision != current else { return }
                NativeHaptics.play(.selection, source: "plugin.policy")
                Task {
                  await operation.run(successEffect: nil) {
                    _ = try await store.request(
                      "/api/v0/plugin-connections/\(API.segment(connection["id"].string))/policy",
                      method: "POST",
                      body: .object([
                        "botId": botID.isEmpty ? .null : .string(botID), "toolName": tool["name"],
                        "decision": .string(decision),
                      ]))
                    data = try await store.request("/api/v0/plugins")
                  }
                }
              })
          ) {
            Text("Ask each time").tag("prompt")
            Text("Allow").tag("allow")
            Text("Deny").tag("deny")
          }
        }
      }
    }.navigationTitle("Tool permissions").disabled(operation.busy).task {
      await operation.run(feedback: false) { data = try await store.request("/api/v0/plugins") }
    }
  }
}

struct PluginToolTestView: View {
  @Environment(AppStore.self) private var store
  let connection: JSON
  @State private var tool = ""
  @State private var arguments = "{}"
  @State private var result = ""
  @State private var confirm = false
  @State private var operation = FormOperation()
  var body: some View {
    NativeForm {
      Section("Tool") {
        Picker("Tool", selection: $tool.hapticSelection("plugin.tool")) {
          Text("Choose…").tag("")
          ForEach(connection["tools"].array, id: \.self) {
            Text($0["name"].string).tag($0["name"].string)
          }
        }
      }
      Section { JSONTextEditor(text: $arguments, label: "Arguments") }
      FormStatus(operation: operation)
      Button("Run test") { confirm = true }.disabled(tool.isEmpty || operation.busy)
      if !result.isEmpty {
        Section("Result") {
          Text(result).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
        }
      }
    }.navigationTitle("Test a tool").confirmationDialog(
      "Run this tool on your connected account?", isPresented: $confirm, titleVisibility: .visible
    ) {
      Button("Run tool") {
        Task {
          await operation.run {
            let response = try await store.request(
              "/api/v0/plugin-connections/\(API.segment(connection["id"].string))/test",
              method: "POST",
              body: .object([
                "toolName": .string(tool),
                "arguments": try FormValidation.json(arguments, label: "Arguments"),
                "confirmSideEffect": .bool(true),
              ]))
            result = UserFacingError.redact(response["result"].pretty)
          }
        }
      }
    } message: {
      Text("Tools can make changes to connected services. Review the arguments before running.")
    }
  }
}
