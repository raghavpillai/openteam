import SwiftUI

struct ProfileRoutinesView: View {
  @Environment(AppStore.self) private var store
  let ownerID: String
  let isGroup: Bool
  @State private var routines: [Routine] = []
  @State private var loading = true
  @State private var failure: String?
  var refreshID: Int
  var onAdd: () -> Void
  var onEdit: (Routine) -> Void
  private var path: String {
    "/api/v0/\(isGroup ? "channels" : "bots")/\(API.segment(ownerID))/routines"
  }
  var body: some View {
    Section {
      if loading {
        ProgressView("Loading routines…")
      } else if let failure {
        InlineFailure(message: failure) { Task { await load() } }
      } else if routines.isEmpty {
        Text("No routines yet").foregroundStyle(NativePalette.faint)
      }
      ForEach(routines) { routine in
        Button {
          onEdit(routine)
        } label: {
          HStack(spacing: 14) {
            Image(systemName: "clock.arrow.circlepath").foregroundStyle(NativePalette.destructive)
              .frame(width: 20)
            VStack(alignment: .leading, spacing: 3) {
              Text(routine.name).foregroundStyle(NativePalette.text)
              Text(routine.scheduleSummary + (routine.enabled ? "" : " · Paused"))
                .font(.subheadline).foregroundStyle(NativePalette.muted)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right").font(.footnote).foregroundStyle(NativePalette.faint)
          }.padding(.vertical, 3)
        }
      }
      Button("Add routine", systemImage: "plus", action: onAdd).foregroundStyle(NativePalette.link)
    } header: {
      NavigationLink {
        RoutinesView(ownerID: ownerID, isGroup: isGroup)
      } label: {
        Text("Routines").font(.footnote).foregroundStyle(NativePalette.faint)
      }
      .accessibilityLabel("Routines")
    }.listRowBackground(NativePalette.assistant)
      .task(id: refreshID) { await load() }
  }

  private func load() async {
    loading = true
    defer { loading = false }
    do {
      routines = try await store.fetch(path, as: [Routine].self)
      failure = nil
    } catch { if !UserFacingError.isCancelled(error) { failure = UserFacingError.message(error) } }
  }
}

struct RoutinesView: View {
  @Environment(AppStore.self) private var store
  let ownerID: String
  let isGroup: Bool
  @State private var routines: [Routine] = []
  @State private var adding = false
  @State private var editing: Routine?
  @State private var failure: String?
  @State private var changing: Set<String> = []
  @State private var loading = true
  var path: String { "/api/v0/\(isGroup ? "channels" : "bots")/\(API.segment(ownerID))/routines" }
  var body: some View {
    NativeList {
      if loading { ProgressView("Loading routines…") }
      if let failure { InlineFailure(message: failure) { Task { await load() } } }
      ForEach(routines) { routine in
        Button {
          editing = routine
        } label: {
          HStack {
            Image(systemName: routine.enabled ? "clock" : "pause.circle").font(.title2)
            VStack(alignment: .leading, spacing: 5) {
              Text(routine.name).font(.headline)
              Text(routine.scheduleSummary).font(.subheadline).foregroundStyle(NativePalette.muted)
              if let next = routine.nextRunAt {
                Text("Next: " + next).font(.caption).foregroundStyle(NativePalette.muted)
              }
            }
          }
        }.swipeActions(edge: .trailing, allowsFullSwipe: false) {
          Button(routine.enabled ? "Pause" : "Resume") {
            Task {
              guard !changing.contains(routine.id) else { return }
              changing.insert(routine.id)
              defer { changing.remove(routine.id) }
              await store.mutate(
                "/api/v0/routines/\(API.segment(routine.id))/\(routine.enabled ? "pause" : "resume")",
                body: .object([
                  "expectedRevision": .number(Double(routine.revision)),
                  "clientId": .string(UUID().uuidString),
                ]))
              await load()
            }
          }.tint(NativePalette.warning).disabled(changing.contains(routine.id))
        }
      }
      if routines.isEmpty, failure == nil, !loading {
        ContentUnavailableView(
          "No routines yet", systemImage: "clock.arrow.circlepath",
          description: Text("Schedule recurring work for this conversation."))
      }
    }.navigationTitle("Routines")
      .toolbar { Button("Add routine", systemImage: "plus") { adding = true } }
      .task { await load() }.refreshable { await load() }
      .sheet(isPresented: $adding, onDismiss: { Task { await load() } }) {
        RoutineEditor(ownerPath: path, routine: nil)
      }
      .sheet(item: $editing, onDismiss: { Task { await load() } }) { routine in
        RoutineEditor(ownerPath: path, routine: routine)
      }
  }
  func load() async {
    loading = true
    defer { loading = false }
    do {
      routines = try await store.fetch(path, as: [Routine].self)
      failure = nil
    } catch { if !UserFacingError.isCancelled(error) { failure = UserFacingError.message(error) } }
  }
}
struct RoutineEditor: View {
  private enum TextFieldFocus: Hashable { case name, prompt }
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  let ownerPath: String
  let routine: Routine?
  @FocusState private var focusedText: TextFieldFocus?
  @State private var name = ""
  @State private var prompt = ""
  @State private var schedule = RoutineScheduleDraft()
  @State private var scheduleTimeZone = TimeZone.current.identifier
  @State private var preservedScheduleSummary = ""
  @State private var preservedPresentation: JSON?
  @State private var enabled = true
  @State private var saving = false
  @State private var deleting = false
  @State private var executions: [JSON] = []
  @State private var requestID = UUID().uuidString
  @State private var failure: String?
  @State private var revision = 0
  @State private var conflict = false
  @State private var reload = false
  @State private var running = false
  @State private var runRequestID = UUID().uuidString
  @State private var runFailure: String?
  @State private var historyFailure: String?
  @State private var historyLoading = false
  @State private var baselineSchedule = ""
  @State private var scheduleEditable = true
  @State private var initialized = false
  var body: some View {
    NavigationStack {
      NativeForm {
        if let failure {
          Section {
            InlineFailure(message: failure)
            if conflict { Button("Reload latest version") { reload = true } }
          }
        }
        Section("Name") {
          TextField("Routine name", text: $name).focused($focusedText, equals: .name)
            .accessibilityIdentifier("routine-name")
        }
        Section("Instructions") {
          TextEditor(text: $prompt).focused($focusedText, equals: .prompt).frame(minHeight: 130)
            .accessibilityIdentifier("routine-prompt")
        }
        Section("Schedule") {
          if !scheduleEditable {
            Text(preservedScheduleSummary).foregroundStyle(NativePalette.muted)
            Text("This trigger will stay unchanged. Edit its schedule on desktop.")
              .font(.caption).foregroundStyle(NativePalette.muted)
          } else {
            RoutineScheduleFields(draft: $schedule, timeZone: scheduleTimeZone)
              .onChange(of: schedule.frequency) { _, _ in focusedText = nil }
          }
          Toggle("Enabled", isOn: $enabled)
        }
        if routine != nil {
          Section {
            Button("Run now", systemImage: "play") {
              Task { await runNow() }
            }.disabled(running || saving)
            if let runFailure { InlineFailure(message: runFailure) { Task { await runNow() } } }
            Button("Delete routine", role: .destructive) { deleting = true }
              .disabled(running || saving)
          }
          Section("Recent runs") {
            if historyLoading && executions.isEmpty { ProgressView("Loading recent runs…") }
            if let historyFailure {
              InlineFailure(message: historyFailure) { Task { await history() } }
            }
            if !historyLoading && executions.isEmpty && historyFailure == nil {
              Text("No runs yet").foregroundStyle(NativePalette.muted)
            }
            ForEach(Array(executions.enumerated()), id: \.offset) { _, execution in
              VStack(alignment: .leading, spacing: 4) {
                Text(execution["status"].string.capitalized).font(.headline)
                Text(execution["createdAt"].string).font(.caption).foregroundStyle(
                  NativePalette.muted)
              }
            }
          }
        }
      }.scrollDismissesKeyboard(.interactively)
        .navigationTitle(routine == nil ? "New routine" : "Routine").navigationBarTitleDisplayMode(
          .inline
        )
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button(saving ? "Saving…" : "Save") { Task { await save() } }.accessibilityIdentifier(
              "routine-save"
            ).disabled(
              saving || running || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
        }
        .task {
          guard !initialized else { return }
          initialized = true
          baselineSchedule = routine?.schedule ?? ""
          scheduleEditable = routine?.scheduleIsEditable ?? true
          name = routine?.name ?? ""
          prompt = routine?.prompt ?? ""
          schedule =
            routine.map { RoutineScheduleDraft(schedule: $0.schedule) } ?? RoutineScheduleDraft()
          scheduleTimeZone = routine?.timezone ?? TimeZone.current.identifier
          preservedScheduleSummary = routine?.scheduleSummary ?? ""
          preservedPresentation = routine?.triggerPresentation
          enabled = routine?.enabled ?? true
          revision = routine?.revision ?? 0
          await history()
        }
        .task(
          id: executions.contains {
            ["queued", "running", "waiting_approval"].contains($0["status"].string)
          }
        ) {
          while executions.contains(where: {
            ["queued", "running", "waiting_approval"].contains($0["status"].string)
          }), !Task.isCancelled {
            do {
              try await Task.sleep(for: .seconds(1.5))
              await history()
            } catch { return }
          }
        }
        .confirmationDialog(
          "Replace your edits with the latest version?", isPresented: $reload,
          titleVisibility: .visible
        ) {
          Button("Reload latest version", role: .destructive) {
            Task {
              do {
                let latest = try await store.fetch(ownerPath, as: [Routine].self)
                guard let next = latest.first(where: { $0.id == routine?.id }) else {
                  throw APIError("This routine was deleted on another device.")
                }
                name = next.name
                prompt = next.prompt
                schedule = RoutineScheduleDraft(schedule: next.schedule)
                scheduleTimeZone = next.timezone
                preservedScheduleSummary = next.scheduleSummary
                preservedPresentation = next.triggerPresentation
                enabled = next.enabled
                revision = next.revision
                baselineSchedule = next.schedule
                scheduleEditable = next.scheduleIsEditable
                conflict = false
                failure = nil
              } catch { failure = UserFacingError.message(error) }
            }
          }
        }
        .confirmationDialog(
          "Delete this routine?", isPresented: $deleting, titleVisibility: .visible
        ) {
          Button("Delete", role: .destructive) {
            Task {
              if let routine,
                await store.mutate(
                  "/api/v0/routines/\(API.segment(routine.id))", method: "DELETE",
                  body: .object([
                    "expectedRevision": .number(Double(revision)),
                    "clientId": .string(UUID().uuidString),
                  ]), successFeedback: .success, feedbackSource: "routine.delete") != nil
              {
                dismiss()
              }
            }
          }
        }
    }
  }
  func history() async {
    guard let routine, !historyLoading else { return }
    historyLoading = true
    defer { historyLoading = false }
    do {
      executions =
        try await store.request(
          "/api/v0/routines/\(API.segment(routine.id))/executions", query: ["limit": "20"]
        ).array
      historyFailure = nil
    } catch {
      if !UserFacingError.isCancelled(error) { historyFailure = UserFacingError.message(error) }
    }
  }
  func runNow() async {
    guard let routine, !running, !saving else { return }
    running = true
    runFailure = nil
    defer { running = false }
    do {
      let execution = try await store.request(
        "/api/v0/routines/\(API.segment(routine.id))/test", method: "POST",
        body: .object(["clientId": .string(runRequestID)]))
      // Preserve the accepted receipt even if the history refresh is unavailable.
      executions.removeAll { $0["id"] == execution["id"] }
      executions.insert(execution, at: 0)
      NativeHaptics.play(.light, source: "routine.run")
      runRequestID = UUID().uuidString
      await history()
    } catch {
      // Reuse this request's ID after an uncertain response so retry cannot start it twice.
      if !UserFacingError.isCancelled(error) {
        NativeHaptics.failure(error, source: "routine.run")
        runFailure = UserFacingError.message(error)
      }
    }
  }
  func save() async {
    guard !saving, !running else { return }
    saving = true
    failure = nil
    defer { saving = false }
    var body: [String: JSON] = [
      "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
      "prompt": .string(prompt.trimmingCharacters(in: .whitespacesAndNewlines)),
      "enabled": .bool(enabled),
      "clientId": .string(requestID),
    ]
    if routine != nil { body["expectedRevision"] = .number(Double(revision)) }
    // Omit unchanged schedules so composite and event triggers survive profile edits.
    if let updatedSchedule = schedule.scheduleUpdate(
      original: routine == nil ? nil : baselineSchedule, editable: scheduleEditable,
      newTimeZone: scheduleTimeZone)
    {
      body["schedule"] = .string(updatedSchedule)
    } else if let preservedPresentation {
      // Keep desktop's advanced editor state on name/prompt/enabled-only edits.
      body["presentation"] = preservedPresentation
    }
    do {
      _ = try await store.request(
        routine.map { "/api/v0/routines/\(API.segment($0.id))" } ?? ownerPath,
        method: routine == nil ? "POST" : "PATCH", body: .object(body))
      NativeHaptics.play(.success, source: "routine.save")
      dismiss()
    } catch {
      NativeHaptics.failure(error, source: "routine.save")
      failure = UserFacingError.message(error)
      conflict = (error as? APIError)?.status == 409
    }
  }
}
