import SwiftUI

/// Server-wide providers for every bot's WebSearch and WebFetch tools: one row per
/// tool showing what is active, with any warnings underneath.
struct ProvidersSettingsView: View {
  @Environment(AppStore.self) private var store
  @State private var view: WebProvidersView?
  @State private var operation = FormOperation()
  var body: some View {
    NativeList {
      if let view {
        Section {
          ForEach(WebTool.allCases, id: \.self) { tool in
            NavigationLink {
              WebToolProvidersView(tool: tool, view: $view)
            } label: {
              toolRow(tool, view[tool])
            }.accessibilityIdentifier("providers-" + tool.rawValue)
              .accessibilityValue(view[tool].activeName(tool))
          }
        } footer: {
          let warnings = WebTool.allCases.compactMap { view[$0].warning($0) }
          if !warnings.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
              ForEach(warnings, id: \.self) { WebProviderWarning(text: $0) }
            }
          }
        }
      } else {
        Section {
          FormStatus(operation: operation)
          if operation.failure != nil { Button("Retry") { Task { await load() } } }
        }
      }
    }.listStyle(.insetGrouped).navigationTitle("Providers").navigationBarTitleDisplayMode(.inline)
      .task { if view == nil { await load() } }
  }
  private func toolRow(_ tool: WebTool, _ toolView: WebToolView) -> some View {
    HStack(spacing: 12) {
      SettingsGlyph(
        symbol: tool == .search ? "magnifyingglass" : "doc.text",
        color: Color(uiColor: tool == .search ? .systemBlue : .systemIndigo))
      Text(tool.title).foregroundStyle(NativePalette.text)
      Spacer(minLength: 8)
      HStack(spacing: 6) {
        if let info = WebProviderCatalog.info(tool, toolView.selected) {
          WebProviderIcon(brand: info.brand, size: 21)
        } else if toolView.selected == nil {
          Image(systemName: "nosign").font(.system(size: 17)).frame(width: 21, height: 21)
        }
        Text(toolView.activeName(tool)).lineLimit(1)
      }.foregroundStyle(NativePalette.muted)
    }
  }
  private func load() async {
    await operation.run(feedback: false) {
      view = WebProvidersView(try await store.request(WebProvidersRequest.path))
    }
  }
}

/// A tool's providers, chosen like a Wi-Fi network: tap to use it, ⓘ for its key and check.
struct WebToolProvidersView: View {
  @Environment(AppStore.self) private var store
  let tool: WebTool
  @Binding var view: WebProvidersView?
  @State private var operation = FormOperation()
  /// The row being selected ("" for Off), which shows progress in place of its checkmark.
  @State private var pending: String?
  @State private var detail: WebProviderInfo?
  private var toolView: WebToolView { view?[tool] ?? WebToolView(selected: nil) }
  var body: some View {
    NativeList {
      Section {
        offRow
        ForEach(WebProviderCatalog.providers(tool)) { providerRow($0) }
      } footer: {
        VStack(alignment: .leading, spacing: 6) {
          if let warning = toolView.warning(tool) { WebProviderWarning(text: warning) }
          Text(tool.footnote)
        }.font(.footnote).foregroundStyle(NativePalette.muted)
      }
      if operation.failure != nil { Section { FormStatus(operation: operation) } }
    }.listStyle(.insetGrouped).navigationTitle(tool.title).navigationBarTitleDisplayMode(.inline)
      .disabled(operation.busy)
      .navigationDestination(item: $detail) { info in
        WebProviderDetailView(tool: tool, info: info, view: $view)
      }
  }
  private var offRow: some View {
    let selected = toolView.selected == nil
    return Button {
      select(nil)
    } label: {
      HStack(spacing: 12) {
        SettingsGlyph(symbol: "nosign", color: Color(uiColor: .systemGray))
        VStack(alignment: .leading, spacing: 1) {
          Text("Off").foregroundStyle(NativePalette.text)
          // A warning only while Off is the active choice.
          Text(tool.offConsequence).font(.caption)
            .foregroundStyle(selected ? NativePalette.warning : NativePalette.muted)
        }
        Spacer(minLength: 8)
        mark(selected: selected, pending: pending == "")
        // Keeps the checkmark in line with the providers' checkmarks beside their ⓘ.
        Color.clear.frame(width: 26, height: 1)
      }.contentShape(Rectangle())
    }.buttonStyle(.borderless).accessibilityIdentifier("providers-" + tool.rawValue + "-off")
      .accessibilityValue(selected ? "In use" : "")
  }
  private func providerRow(_ info: WebProviderInfo) -> some View {
    let state = toolView[info.id]
    let status = WebProviderStatus(info, state)
    let selected = toolView.selected == info.id
    return HStack(spacing: 12) {
      Button {
        // A provider without its key can't be used yet; open it to add one.
        if info.needsKey && !state.ready { detail = info } else { select(info.id) }
      } label: {
        HStack(spacing: 12) {
          WebProviderIcon(brand: info.brand)
          VStack(alignment: .leading, spacing: 1) {
            Text(info.name).foregroundStyle(NativePalette.text)
            Text(status.text).font(.caption)
              .foregroundStyle(status.tone == .error ? NativePalette.destructive : NativePalette.muted)
          }
          Spacer(minLength: 8)
          mark(selected: selected, pending: pending == info.id)
        }.contentShape(Rectangle())
      }.buttonStyle(.borderless).accessibilityIdentifier("providers-\(tool.rawValue)-\(info.id)")
        .accessibilityValue([selected ? "In use" : nil, status.text].compactMap { $0 }.joined(separator: ", "))
      Button {
        detail = info
      } label: {
        Image(systemName: "info.circle").font(.system(size: 21)).frame(width: 26)
      }.buttonStyle(.borderless).accessibilityLabel(info.name + " details")
        .accessibilityIdentifier("providers-\(tool.rawValue)-\(info.id)-info")
    }
  }
  @ViewBuilder private func mark(selected: Bool, pending: Bool) -> some View {
    if pending {
      ProgressView()
    } else if selected {
      Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(.tint)
    }
  }
  private func select(_ id: String?) {
    guard toolView.selected != id, !operation.busy else { return }
    pending = id ?? ""
    Task {
      await operation.run {
        view = WebProvidersView(
          try await store.request(
            WebProvidersRequest.path, method: "PATCH", body: WebProvidersRequest.select(tool, id)))
      }
      pending = nil
    }
  }
}

/// One provider for one tool: its key, selection and connection check.
struct WebProviderDetailView: View {
  @Environment(AppStore.self) private var store
  let tool: WebTool
  let info: WebProviderInfo
  @Binding var view: WebProvidersView?
  @State private var draft = WebProviderDraft()
  @State private var operation = FormOperation()
  @State private var checking = false
  @State private var removing = false
  private var state: WebProviderState { view?[tool][info.id] ?? WebProviderState() }
  private var inUse: Bool { view?[tool].selected == info.id }
  var body: some View {
    let missing = draft.missingKey(info, saved: state)
    NativeForm {
      Section {
        HStack(spacing: 14) {
          WebProviderIcon(brand: info.brand, size: 48)
          VStack(alignment: .leading, spacing: 3) {
            Text(info.name).font(.headline)
            Text(info.description).font(.subheadline).foregroundStyle(NativePalette.muted)
          }
        }.padding(.vertical, 4)
      }
      if info.needsKey {
        Section {
          SecureField(state.secretSaved ? "Replace key" : "API key", text: $draft.key)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .accessibilityIdentifier("provider-field-apiKey")
          Button("Save") { Task { await save() } }.disabled(draft.patch(tool, info) == nil)
            .accessibilityIdentifier("provider-save")
        } header: {
          Text("API key")
        } footer: {
          Text(
            (state.secretSaved ? "A key is saved. " : "")
              + "Keys are stored on your server and never shown again."
          ).font(.footnote).foregroundStyle(NativePalette.muted)
        }
        if state.secretSaved {
          Section {
            Button("Remove key", role: .destructive) { removing = true }.disabled(inUse)
              .accessibilityIdentifier("provider-remove-apiKey")
          } footer: {
            if inUse {
              Text("Choose another \(tool.rawValue) provider before removing this key.")
                .font(.footnote).foregroundStyle(NativePalette.muted)
            }
          }
        }
      }
      Section {
        if inUse {
          Label("In use for \(tool.rawValue)", systemImage: "checkmark")
            .foregroundStyle(NativePalette.muted).accessibilityElement(children: .combine)
            .accessibilityIdentifier("provider-use")
        } else {
          Button("Use for " + tool.title) { Task { await use() } }.disabled(missing)
            .accessibilityIdentifier("provider-use")
          if missing {
            Text(WebProvidersRequest.missingKeyMessage(info, tool: tool)).font(.footnote)
              .foregroundStyle(NativePalette.warning)
          }
        }
      }
      Section {
        Button {
          Task { await check() }
        } label: {
          HStack {
            Text("Check connection")
            Spacer()
            if checking { ProgressView() }
          }
        }.disabled(missing).accessibilityIdentifier("provider-check")
        if let check = state.check {
          HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: check.passed ? "checkmark.circle.fill" : "xmark.octagon.fill")
              .foregroundStyle(
                check.passed ? Color(uiColor: .systemGreen) : NativePalette.destructive)
            VStack(alignment: .leading, spacing: 2) {
              Text(check.message).fixedSize(horizontal: false, vertical: true)
              Text("Checked " + check.ago()).font(.footnote).foregroundStyle(NativePalette.muted)
            }
          }.font(.subheadline).accessibilityElement(children: .combine)
            .accessibilityValue(check.passed ? "Passed" : "Failed")
            .accessibilityIdentifier("provider-check-result")
        }
      } footer: {
        Text(
          tool == .search ? "Runs a real test search." : "Fetches a real web page."
        ).font(.footnote).foregroundStyle(NativePalette.muted)
      }
      Section { FormStatus(operation: operation, progress: !checking) }
      if let url = info.setupURL {
        Section { Link("Get a key", destination: url) }
      }
    }.navigationTitle(info.name).navigationBarTitleDisplayMode(.inline)
      .scrollDismissesKeyboard(.interactively)
      .disabled(operation.busy).onDisappear { draft = WebProviderDraft() }
      .confirmationDialog(
        "Remove the \(info.name) API key?", isPresented: $removing, titleVisibility: .visible
      ) {
        Button("Remove key", role: .destructive) { Task { await removeKey() } }
      } message: {
        Text("You can add a key again at any time.")
      }
  }
  /// Replaces the shared view, so both provider lists reflect every change.
  private func send(_ body: JSON) async throws {
    view = WebProvidersView(
      try await store.request(WebProvidersRequest.path, method: "PATCH", body: body))
    draft = WebProviderDraft()
  }
  private func save() async {
    guard let body = draft.patch(tool, info) else { return }
    await operation.run(success: "Saved.") { try await send(body) }
  }
  private func removeKey() async {
    await operation.run(success: "Key removed.") {
      try await send(WebProvidersRequest.removeKey(tool, info.id))
    }
  }
  private func use() async {
    // A typed key is saved with the selection, so it works at once.
    guard let body = draft.patch(tool, info, select: true) else { return }
    await operation.run { try await send(body) }
  }
  private func check() async {
    let completed = await operation.run(successEffect: nil) {
      // The server checks the saved key, so save a typed one first.
      if let body = draft.patch(tool, info) { try await send(body) }
      checking = true
      defer { checking = false }
      view = WebProvidersView(
        try await store.request(
          WebProvidersRequest.checkPath, method: "POST",
          body: WebProvidersRequest.check(tool, info.id), timeout: 90))
    }
    if completed, let check = state.check {
      NativeHaptics.play(check.passed ? .success : .error, source: "providers.check")
    }
  }
}

/// Brand artwork from the asset catalog in a fixed square, or a neutral globe for an unknown brand.
struct WebProviderIcon: View {
  let brand: String
  var size: CGFloat = 29
  var body: some View {
    Group {
      if UIImage(named: "WebProvider-" + brand) != nil {
        Image("WebProvider-" + brand).resizable().scaledToFit()
      } else {
        Image(systemName: "globe").font(.system(size: size * 0.55))
          .foregroundStyle(NativePalette.muted)
          .frame(maxWidth: .infinity, maxHeight: .infinity).background(NativePalette.code)
      }
    }.frame(width: size, height: size)
      .clipShape(RoundedRectangle(cornerRadius: size * 7 / 29, style: .continuous))
      .accessibilityHidden(true)
  }
}

/// A Settings-style white symbol on a colored rounded tile.
struct SettingsGlyph: View {
  let symbol: String
  let color: Color
  var size: CGFloat = 29
  var body: some View {
    Image(systemName: symbol).font(.system(size: size * 0.52, weight: .semibold))
      .foregroundStyle(.white).frame(width: size, height: size)
      .background(color, in: RoundedRectangle(cornerRadius: size * 7 / 29, style: .continuous))
      .accessibilityHidden(true)
  }
}

struct WebProviderWarning: View {
  let text: String
  var body: some View {
    Label {
      Text(text)
    } icon: {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(NativePalette.warning)
    }.font(.footnote).foregroundStyle(NativePalette.muted)
  }
}
