import SwiftUI

struct AutoReviewRulesView: View {
  @Environment(AppStore.self) private var store
  @State private var enabled = true
  @State private var allow: [String] = []
  @State private var block: [String] = []
  @State private var baseline: JSON?
  @State private var operation = FormOperation()
  private let path = "/api/v0/server-settings/auto-review"
  var body: some View {
    NativeForm {
      Section {
        FormStatus(operation: operation)
        if baseline == nil {
          Button("Retry") { Task { await load() } }
        } else {
          Toggle("Auto-review", isOn: $enabled).tint(NativePalette.toggle)
        }
      }
      if baseline != nil {
        Section {
          Text("These rules apply to actions reviewed by this server.").font(.footnote)
            .foregroundStyle(NativePalette.muted)
        }
        rules("Allow", values: $allow)
        rules("Block", values: $block)
        Section {
          Button("Save rules") { Task { await save() } }.accessibilityIdentifier(
            "save-review-rules")
          Button("Reload saved rules") { Task { await load() } }
        }
      }
    }.navigationTitle("Auto-review rules").navigationBarTitleDisplayMode(.inline)
      .disabled(operation.busy).task { if baseline == nil { await load() } }
  }
  @ViewBuilder private func rules(_ title: String, values: Binding<[String]>) -> some View {
    Section {
      ForEach(values.wrappedValue.indices, id: \.self) { index in
        VStack(alignment: .leading) {
          TextField(
            title + " rule",
            text: Binding(
              get: {
                values.wrappedValue.indices.contains(index) ? values.wrappedValue[index] : ""
              },
              set: { value in
                if values.wrappedValue.indices.contains(index) {
                  values.wrappedValue[index] = value
                }
              }), axis: .vertical
          ).lineLimit(2...8).accessibilityIdentifier(
            "review-" + title.lowercased() + "-" + String(index))
          Button("Remove rule", role: .destructive) {
            if values.wrappedValue.indices.contains(index) { values.wrappedValue.remove(at: index) }
          }.font(.footnote)
        }
      }
      Button("Add " + title.lowercased() + " rule", systemImage: "plus") {
        values.wrappedValue.append("")
      }
      .disabled(values.wrappedValue.count >= 20)
    } header: {
      Text(title)
    } footer: {
      Text("Up to 20 rules, 1,000 characters each.")
    }
  }
  private func policy(_ json: JSON) -> JSON {
    .object([
      "isEnabled": json["isEnabled"], "allowInstructions": json["allowInstructions"],
      "blockInstructions": json["blockInstructions"],
    ])
  }
  private func load() async {
    await operation.run(feedback: false) {
      let result = try await store.request(path)
      enabled = result["isEnabled"].bool
      allow = result["allowInstructions"].array.map(\.string)
      block = result["blockInstructions"].array.map(\.string)
      baseline = policy(result)
    }
  }
  private func save() async {
    await operation.run(success: "Rules saved.") {
      let allowRows = allow.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      let blockRows = block.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      guard allowRows.count <= 20, blockRows.count <= 20,
        (allowRows + blockRows).allSatisfy({ !$0.isEmpty && $0.utf16.count <= 1000 })
      else {
        throw APIError(
          "Enter a nonempty instruction of up to 1,000 characters for each rule, or remove the empty rule."
        )
      }
      let latest = try await store.request(path)
      guard policy(latest) == baseline else {
        throw APIError("Rules changed on another device. Reload saved rules before saving.")
      }
      let body: JSON = .object([
        "isEnabled": .bool(enabled), "allowInstructions": .array(allowRows.map(JSON.string)),
        "blockInstructions": .array(blockRows.map(JSON.string)),
      ])
      do { _ = try await store.request(path, method: "PATCH", body: body) } catch {
        let actual = try await store.request(path)
        guard policy(actual) == body else { throw error }
      }
      let actual = try await store.request(path)
      guard policy(actual) == body else {
        throw APIError(
          "Rules could not be confirmed. Reload saved rules to check their current state.")
      }
      baseline = body
      allow = allowRows
      block = blockRows
    }
  }
}
