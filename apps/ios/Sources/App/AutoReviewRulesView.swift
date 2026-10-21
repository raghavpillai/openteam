import SwiftUI

/// Auto-review: whether OpenTeam checks risky actions first, and the user's Allow and Ask first rules.
struct AutoReviewRulesView: View {
  static let path = "/api/v0/server-settings/auto-review"
  @Environment(AppStore.self) private var store
  @State private var enabled = true
  @State private var allowRules: [String] = []
  @State private var askFirstRules: [String] = []
  @State private var loaded = false
  @State private var operation = FormOperation()
  @State private var editing: Edit?

  struct Edit: Identifiable {
    let askFirst: Bool
    let index: Int?
    var text: String
    var id: String { "\(askFirst)-\(index ?? -1)" }
  }

  var body: some View {
    NativeList {
      if loaded {
        Section {
          Toggle("Auto-review", isOn: Binding(get: { enabled }, set: { value in save(["enabled": .bool(value)]) }))
            .tint(NativePalette.toggle).accessibilityIdentifier("auto-review-toggle")
        } footer: {
          Text(enabled
            ? "OpenTeam checks each action before it runs and asks you first when needed. Add rules to customize what it can do automatically."
            : "OpenTeam runs actions without checking them. Tools set to Needs approval still ask.")
        }
        rules(askFirst: false)
        rules(askFirst: true)
        Section {
        } footer: {
          Text(enabled ? "These rules apply only to you. Built-in safety checks always apply." : "Rules aren't used while Auto-review is off")
        }
      }
      Section { FormStatus(operation: operation) }
    }
    .listStyle(.insetGrouped).navigationTitle("Auto-review").navigationBarTitleDisplayMode(.inline)
    .task { if !loaded { await load() } }
    .sheet(item: $editing) { edit in
      NavigationStack {
        Form {
          Section {
            TextField("Rule", text: Binding(get: { editing?.text ?? "" }, set: { editing?.text = $0 }), axis: .vertical)
              .lineLimit(3...8)
          } footer: {
            Text("Write one short, natural-language rule for each action. \"Ask first\" takes priority if rules conflict.")
          }
        }
        .navigationTitle(edit.index == nil ? (edit.askFirst ? "Add Ask first rule" : "Add Allow rule") : "Edit rule")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { editing = nil } }
          ToolbarItem(placement: .confirmationAction) {
            Button("Save rule") { saveEdit() }
              .disabled((editing?.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) && edit.index == nil)
          }
        }
      }.presentationDetents([.medium])
    }
  }

  @ViewBuilder private func rules(askFirst: Bool) -> some View {
    let list = askFirst ? askFirstRules : allowRules
    Section {
      ForEach(Array(list.enumerated()), id: \.offset) { index, rule in
        Button { editing = Edit(askFirst: askFirst, index: index, text: rule) } label: {
          Text(rule).foregroundStyle(NativePalette.text).frame(maxWidth: .infinity, alignment: .leading)
        }
        .swipeActions {
          Button("Delete", role: .destructive) {
            var next = list
            next.remove(at: index)
            save([askFirst ? "askFirstRules" : "allowRules": .array(next.map { .string($0) })])
          }
        }
        .accessibilityLabel((askFirst ? "Ask first rule " : "Allow rule ") + "\(index + 1): " + rule)
      }
      if list.count < 20 {
        Button(askFirst ? "Add Ask first rule" : "Add Allow rule") { editing = Edit(askFirst: askFirst, index: nil, text: "") }
      }
    } header: {
      Text(askFirst ? "Ask first rules" : "Allow rules")
    } footer: {
      Text(askFirst
        ? "OpenTeam stops and asks you before anything that matches, even if it would otherwise go ahead. Ask first wins over Allow."
        : "OpenTeam usually goes ahead without asking for anything that matches, unless an Ask first rule also matches. Built-in safety checks still apply.")
    }
  }

  private func apply(_ result: JSON) {
    enabled = result["enabled"].bool
    allowRules = result["allowRules"].array.map(\.string)
    askFirstRules = result["askFirstRules"].array.map(\.string)
    loaded = true
  }

  private func load() async {
    await operation.run(feedback: false) { apply(try await store.request(Self.path)) }
  }

  private func save(_ change: [String: JSON]) {
    Task {
      await operation.run(feedback: false) {
        apply(try await store.request(Self.path, method: "PATCH", body: .object(change)))
      }
    }
  }

  private func saveEdit() {
    guard let edit = editing else { return }
    var list = edit.askFirst ? askFirstRules : allowRules
    let text = edit.text.trimmingCharacters(in: .whitespacesAndNewlines)
    if let index = edit.index {
      if text.isEmpty { list.remove(at: index) } else { list[index] = text }
    } else {
      list.append(text)
    }
    editing = nil
    save([edit.askFirst ? "askFirstRules" : "allowRules": .array(list.map { .string($0) })])
  }
}
