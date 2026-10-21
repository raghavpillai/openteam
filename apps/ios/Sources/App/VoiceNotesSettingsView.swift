import SwiftUI

/// Settings → Voice notes: the server's transcription service, shared by desktop and iPhone.
struct VoiceNotesSettingsView: View {
  @Environment(AppStore.self) private var store
  @State private var saved: TranscriptionSettingsView?
  @State private var draft = TranscriptionDraft(nil)
  @State private var operation = FormOperation()
  @State private var check: TranscriptionCheck?
  @State private var checking = false
  @State private var loadFailed = false
  @FocusState private var focused: Field?
  private enum Field { case baseUrl, model, apiKey, language }

  var body: some View {
    let savedView = saved
    let changed = draft.changed(from: savedView)
    let hasSavedKey = draft.hasSavedKey(savedView)
    NativeForm {
      if savedView == nil {
        Section {
          if loadFailed {
            InlineFailure(
              message:
                "Could not load transcription settings. Check the server connection."
            ) { Task { await load() } }
          } else {
            LoadingOrbLabel(title: "Loading…")
          }
        }
      } else {
        Section {
          Toggle("Voice notes", isOn: $draft.settings.enabled).tint(NativePalette.toggle)
            .accessibilityIdentifier("voice-enabled")
        } footer: {
          SettingsFooter(
            "Record a message, then let your server transcribe it. Applies to desktop and iPhone.")
        }
        Section {
          HStack(spacing: 12) {
            // The chosen service's official icon; a custom service shows a generic one.
            ProviderMark(kind: ProviderMark.kind(for: draft.settings.provider), size: 24)
              .id(draft.settings.provider)
              .transition(.opacity.combined(with: .scale(scale: 0.7)))
            Picker(
              "Provider",
              selection: Binding(
                get: { draft.settings.provider },
                set: { provider in
                  NativeHaptics.play(.selection, source: "voice.provider")
                  draft.choose(provider)
                  check = nil
                  operation.success = nil
                })
            ) {
              ForEach(TranscriptionSettings.Provider.allCases) { Text($0.title).tag($0) }
            }.pickerStyle(.segmented).accessibilityIdentifier("voice-provider")
          }
          .animation(.snappy, value: draft.settings.provider)
          LabeledContent("Base URL") {
            TextField("http://audio-server:8000/v1", text: $draft.settings.baseUrl)
              .multilineTextAlignment(.trailing).keyboardType(.URL)
              .textInputAutocapitalization(.never).autocorrectionDisabled()
              .disabled(draft.settings.provider != .compatible)
              .foregroundStyle(
                draft.settings.provider == .compatible ? NativePalette.text : NativePalette.muted)
              .focused($focused, equals: .baseUrl)
              .accessibilityIdentifier("voice-base-url")
          }
          LabeledContent("Model") {
            TextField("Model ID", text: $draft.settings.model)
              .multilineTextAlignment(.trailing)
              .textInputAutocapitalization(.never).autocorrectionDisabled()
              .focused($focused, equals: .model)
              .accessibilityIdentifier("voice-model")
          }
        } header: {
          SettingsHeader("Service")
        } footer: {
          SettingsFooter("The address your OpenTeam server uses to reach the audio service.")
        }
        Section {
          SecureField(hasSavedKey ? "Key saved" : "API key", text: $draft.apiKey)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .textContentType(.password)
            .focused($focused, equals: .apiKey)
            .accessibilityLabel("Transcription API key")
            .accessibilityIdentifier("voice-api-key")
          if savedView?.hasApiKey == true, draft.sameEndpoint(as: savedView) {
            Toggle("Remove saved key", isOn: $draft.removeKey).tint(NativePalette.destructive)
              .accessibilityIdentifier("voice-remove-key")
          }
        } header: {
          SettingsHeader("API key")
        } footer: {
          SettingsFooter(
            hasSavedKey
              ? "A key is saved. Leave blank to keep it."
              : "Required for OpenAI and Deepgram; optional for private services.")
        }
        Section {
          TextField("Automatic", text: $draft.settings.language)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .focused($focused, equals: .language)
            .accessibilityLabel("Transcription language")
            .accessibilityIdentifier("voice-language")
        } header: {
          SettingsHeader("Language")
        } footer: {
          SettingsFooter("Leave blank for automatic detection, or enter a language code such as en.")
        }
        Section {
          HStack(spacing: 10) {
            Button {
              Task { await runCheck() }
            } label: {
              HStack(spacing: 6) {
                if checking { LoadingOrb(size: 16, label: "Checking") }
                Text("Test connection")
              }.frame(maxWidth: .infinity)
            }.buttonStyle(ModelCapsuleButtonStyle())
              .disabled(operation.busy || checking || changed || savedView?.configured != true)
              .accessibilityIdentifier("voice-test")
            Button {
              Task { await save() }
            } label: {
              HStack(spacing: 6) {
                if operation.busy && !checking {
                  PrimaryLoadingOrb(label: "Saving")
                }
                Text("Save")
              }.frame(maxWidth: .infinity)
            }.buttonStyle(ModelCapsuleButtonStyle(primary: true))
              .disabled(operation.busy || checking || !changed)
              .accessibilityIdentifier("voice-save")
          }
          if let check {
            Label {
              Text(check.detail).fixedSize(horizontal: false, vertical: true)
            } icon: {
              Image(
                systemName: check.level == "pass"
                  ? "checkmark.circle.fill"
                  : check.level == "warn" ? "exclamationmark.triangle.fill" : "xmark.octagon.fill"
              ).foregroundStyle(
                check.level == "pass"
                  ? Color(uiColor: .systemGreen)
                  : check.level == "warn" ? NativePalette.warning : NativePalette.destructive)
            }.font(.subheadline).accessibilityIdentifier("voice-check-result")
          }
          FormStatus(operation: operation, progress: false)
        }
      }
    }
    .navigationTitle("Voice notes").navigationBarTitleDisplayMode(.inline)
    .scrollDismissesKeyboard(.interactively)
    .onChange(of: draft) { _, _ in
      check = nil
      operation.success = nil
    }
    .task { if saved == nil { await load() } }
  }

  private func load() async {
    loadFailed = false
    do {
      let value = try await store.request(TranscriptionRequest.path).decode(
        TranscriptionSettingsView.self)
      saved = value
      draft = TranscriptionDraft(value)
    } catch {
      if !UserFacingError.isCancelled(error) { loadFailed = true }
    }
  }

  private func save() async {
    focused = nil
    var message: String?
    await operation.run {
      let value = try await store.request(
        TranscriptionRequest.path, method: "PUT", body: draft.body
      ).decode(TranscriptionSettingsView.self)
      saved = value
      draft = TranscriptionDraft(value)
      message = TranscriptionRequest.savedMessage(value)
      await store.refreshRuntime()
    }
    if let message { operation.success = message }
  }

  private func runCheck() async {
    checking = true
    defer { checking = false }
    await operation.run(successEffect: nil) {
      let result = try await store.request(
        TranscriptionRequest.checkPath, method: "POST", body: .object([:]), timeout: 90
      ).decode(TranscriptionCheck.self)
      check = result
      NativeHaptics.play(result.level == "fail" ? .error : .success, source: "voice.check")
    }
  }
}
