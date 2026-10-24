import SwiftUI

/// The model the bots will use, as a select-style dropdown: a native menu for a short
/// list, a searchable sheet for a long one (OpenRouter, an OpenAI key). Models stay in
/// the order the server's catalog lists them, the recommended one first and tagged.
struct ModelDropdown: View {
  let models: [InferenceModel]
  let selected: String
  var recommended: String?
  var disabled = false
  var accessibilityID = "wizard-model-menu"
  var horizontalPadding: CGFloat = 16
  /// Opens the searchable sheet, which the page owns so it outlives this row.
  let search: () -> Void
  let choose: (String) -> Void

  private var current: InferenceModel? { models.first { $0.modelId == selected } }
  private var long: Bool { models.count > ModelSearchSheet.threshold }

  var body: some View {
    Group {
      if long {
        Button(action: search) { label(symbol: "magnifyingglass") }
          .buttonStyle(WizardRowButtonStyle())
      } else {
        Menu {
          // Toggles show the menu's checkmark, and a second Text is the item's subtitle.
          // The app's switch style would turn each toggle into several menu items.
          ForEach(models) { model in item(model) }
            .toggleStyle(.automatic)
        } label: {
          label(symbol: "chevron.up.chevron.down")
        }
        .menuOrder(.fixed)
        .buttonStyle(WizardRowButtonStyle())
      }
    }
    .disabled(disabled)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Model, \(current?.name ?? selected)")
    .accessibilityHint(long ? "Search \(models.count) models" : "Choose from \(models.count) models")
    .accessibilityIdentifier(accessibilityID)
  }

  @ViewBuilder private func item(_ model: InferenceModel) -> some View {
    if model.modelId == recommended {
      Toggle(isOn: picked(model)) {
        Text(model.name)
        Text("Recommended")
      }
    } else {
      Toggle(model.name, isOn: picked(model))
    }
  }

  /// On for the current model; turning another one on chooses it.
  private func picked(_ model: InferenceModel) -> Binding<Bool> {
    Binding(
      get: { model.modelId == selected },
      set: { on in if on, model.modelId != selected { choose(model.modelId) } })
  }

  private func label(symbol: String) -> some View {
    HStack(spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Text("Model").font(.body).foregroundStyle(.primary)
        Text(
          long
            ? "Search \(models.count) models"
            : selected == recommended ? "Recommended" : "\(models.count) models")
          .font(.subheadline).foregroundStyle(.secondary)
          .contentTransition(.opacity)
      }
      Spacer(minLength: 8)
      Text(current?.name ?? selected).font(.body).foregroundStyle(.secondary)
        .lineLimit(1).truncationMode(.middle)
        .contentTransition(.opacity)
      Image(systemName: symbol).font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
    }
    .padding(.horizontal, horizontalPadding).frame(minHeight: 56).contentShape(Rectangle())
    .animation(.smooth, value: selected)
  }
}

/// Choosing from hundreds of models (OpenRouter): a native searchable list, with the
/// recommended model first and marked.
struct ModelSearchSheet: View {
  /// More models than this get the searchable sheet instead of a menu.
  static let threshold = 12
  @Environment(\.dismiss) private var dismiss
  let models: [InferenceModel]
  let selected: String
  var recommended: String?
  let choose: (String) -> Void
  @State private var query = ""

  private var results: [InferenceModel] {
    let words = query.lowercased().split(separator: " ").map(String.init)
    guard !words.isEmpty else { return models }
    return models.filter { model in
      let text = (model.name + " " + model.modelId).lowercased()
      return words.allSatisfy { text.contains($0) }
    }
  }

  var body: some View {
    NavigationStack {
      List {
        ForEach(results) { model in
          Button {
            NativeHaptics.play(.selection, source: "onboarding.model")
            choose(model.modelId)
            dismiss()
          } label: {
            row(model)
          }
          .accessibilityIdentifier("model-option-" + model.modelId)
        }
      }
      .listStyle(.insetGrouped)
      .overlay {
        if results.isEmpty { ContentUnavailableView.search(text: query) }
      }
      .animation(.smooth(duration: 0.3), value: query)
      .searchable(
        text: $query, placement: .navigationBarDrawer(displayMode: .always),
        prompt: "Search \(models.count) models")
      .navigationTitle("Choose a model").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.accessibilityIdentifier("model-search-cancel")
        }
      }
    }
    .presentationDetents([.large])
    .accessibilityIdentifier("model-search")
  }

  private func row(_ model: InferenceModel) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(model.name).font(.body).foregroundStyle(.primary).lineLimit(1)
          if model.modelId == recommended {
            Text("Recommended").font(.caption2.weight(.semibold))
              .foregroundStyle(WizardStage.model.accent)
              .padding(.horizontal, 6).padding(.vertical, 2)
              .background(WizardStage.model.accent.opacity(0.14), in: Capsule())
          }
        }
        Text(model.modelId).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
      }
      Spacer(minLength: 8)
      if model.modelId == selected {
        Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(.tint)
      }
    }
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(model.modelId == selected ? .isSelected : [])
  }
}
