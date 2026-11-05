import Observation
import SwiftUI

@MainActor @Observable final class ServerUpdateModel {
  let clientVersion =
    Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
  var release: ServerRelease?
  var update: ServerUpdateStatus?
  var busyNames: [String] = []
  var checking = false
  var loading = true
  var starting = false
  var failure: String?
  var actionFailure: String?
  var reconnecting = false
  var startedAt: Date?
  var observedAt: Date?
  private var cacheServer: String?
  private var busyCheckFailed = true
  var policy: ServerUpdatePolicy {
    ServerUpdatePolicy(clientVersion: clientVersion, release: release)
  }
  var updating: Bool { starting || update?.updating == true }
  var canUpdate: Bool {
    !checking && !updating && !busyCheckFailed && busyNames.isEmpty
      && policy.targetVersion != nil && update?.updaterAvailable == true
  }

  private func restore(_ server: String) {
    guard cacheServer != server else { return }
    cacheServer = server
    release = nil
    update = nil
    startedAt = nil
    observedAt = nil
    busyNames = []
    failure = nil
    actionFailure = nil
    reconnecting = false
    loading = true
    if let cached = ServerUpdateCache.load(server: server) {
      release = cached.release
      update = cached.update
      startedAt = cached.startedAt
      observedAt = cached.observedAt
      reconnecting = true
      loading = false
    }
  }
  private func persist(_ server: String) {
    let snapshot = update.flatMap { status in
      observedAt.map {
        ServerUpdateSnapshot(release: release, update: status, observedAt: $0, startedAt: startedAt)
      }
    }
    ServerUpdateCache.save(snapshot, server: server)
  }

  func refresh(_ store: AppStore) async {
    let server = store.server
    restore(server)
    guard !checking && !starting else { return }
    checking = true
    defer {
      checking = false
      loading = false
      if store.server == server { persist(server) }
    }
    var releaseRead = false
    do {
      release = try await store.request("/api/v0/system/version", timeout: 5).decode(
        ServerRelease.self)
      failure = nil
      releaseRead = true
    } catch {
      guard !UserFacingError.isCancelled(error) else { return }
      if update?.updating != true { release = nil }
      reconnecting = update?.updating == true
      failure = reconnecting ? nil : UserFacingError.message(error)
    }
    do {
      let next = try await store.request("/api/v0/system/update", timeout: 5).decode(
        ServerUpdateStatus.self)
      // Keep progress until the live version endpoint confirms the restarted server.
      if next.status == "updated" && !releaseRead && update?.updating == true {
        reconnecting = true
      } else {
        // The host replaces the queued request ID with its installation job ID.
        if next.targetVersion != update?.targetVersion
          || (next.jobId != update?.jobId && !["checking", "queued"].contains(update?.phase ?? ""))
        {
          startedAt = nil
        }
        update = next
        observedAt = Date()
        if releaseRead { reconnecting = false }
      }
    } catch {
      guard !UserFacingError.isCancelled(error) else { return }
      if update?.updating != true { update = nil } else { reconnecting = true }
    }
    if policy.targetVersion != nil && !updating {
      do { try await checkBusy(store) } catch {
        guard !UserFacingError.isCancelled(error) else { return }
        busyCheckFailed = true
        failure = UserFacingError.message(error)
      }
    }
  }

  private func checkBusy(_ store: AppStore) async throws {
    busyCheckFailed = true
    let busy = try await store.request("/api/v0/system/busy-bots", timeout: 5)
    guard case .array(let bots) = busy["bots"] else {
      throw APIError("Could not check whether bots are working.")
    }
    busyNames = bots.map { $0["name"].string }.map { $0.isEmpty ? "A bot" : $0 }
    busyCheckFailed = false
  }

  func start(_ store: AppStore) async {
    guard !starting, update?.updating != true else { return }
    let server = store.server
    starting = true
    actionFailure = nil
    defer {
      starting = false
      if store.server == server { persist(server) }
    }
    do {
      // Let an in-flight poll finish before using its version and updater state.
      while checking { try await Task.sleep(for: .milliseconds(40)) }
      guard let target = policy.targetVersion, update?.updaterAvailable == true else { return }
      // Work can begin while the confirmation is open. The host checks again too.
      try await checkBusy(store)
      guard busyNames.isEmpty, store.server == server else { return }
      startedAt = Date()
      update = try await store.request(
        "/api/v0/system/update", method: "POST",
        body: .object(["targetVersion": .string(target)])
      ).decode(ServerUpdateStatus.self)
      observedAt = Date()
    } catch {
      if !UserFacingError.isCancelled(error) { actionFailure = UserFacingError.message(error) }
    }
  }
}

struct UpdatesSettingsView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.colorScheme) private var colorScheme
  @State private var model = ServerUpdateModel()
  @State private var confirming = false
  private var progress: ServerUpdateProgress {
    ServerUpdateProgress(phase: model.starting ? "checking" : model.update?.phase)
  }
  private var current: String { model.release?.releaseVersion ?? "—" }
  private var target: String {
    model.update?.targetVersion ?? model.policy.targetVersion ?? model.clientVersion
  }
  private var host: String {
    guard let url = URLComponents(string: store.server), let host = url.host else {
      return store.server
    }
    return host + (url.port.map { ":\($0)" } ?? "")
  }
  private var healthy: Bool {
    !model.loading && !model.updating && model.policy.compatibility == .compatible
  }

  var body: some View {
    Form {
      Section {
        Label {
          VStack(alignment: .leading, spacing: 4) {
            Text("OpenTeam server").font(.headline)
            Text(host).font(.subheadline).foregroundStyle(.secondary)
              .textSelection(.enabled)
          }
        } icon: {
          Image(systemName: "server.rack").foregroundStyle(.secondary)
        }
        LabeledContent(model.reconnecting ? "Last known version" : "Version") {
          HStack(spacing: 8) {
            Text(current).foregroundStyle(.secondary)
            if model.updating || model.policy.targetVersion != nil {
              Image(systemName: "arrow.right").font(.caption).foregroundStyle(.tertiary)
              Text(target).foregroundStyle(.blue)
            }
          }.monospacedDigit()
        }.accessibilityIdentifier("server-update-version")
        if model.loading {
          ProgressView("Checking your server…")
        } else if model.updating {
          progressRows
        } else {
          serverActions
        }
      } header: {
        Text("Connected server")
      } footer: {
        if model.updating {
          progressFooter
        } else if !model.loading {
          statusCopy.font(.footnote).foregroundStyle(.secondary)
        }
      }

      if !model.updating,
        let failure = model.actionFailure ?? model.failure
          ?? (model.update?.status == "error" ? model.update?.message : nil)
      {
        Section {
          Label(failure, systemImage: "exclamationmark.circle")
            .foregroundStyle(.red)
        } header: {
          Text("Couldn't update server")
        }
      }

      Section("App") {
        Link(destination: MobileRelease.testFlightURL) {
          HStack {
            VStack(alignment: .leading, spacing: 3) {
              Text("iOS app")
              Text("Version \(model.clientVersion) · TestFlight").font(.caption).foregroundStyle(
                .secondary)
            }
            Spacer()
            Image(systemName: "arrow.up.right").font(.subheadline).foregroundStyle(.secondary)
          }
        }.foregroundStyle(.primary).accessibilityIdentifier("ios-app-update").accessibilityLabel(
          "Open TestFlight"
        )
        .accessibilityHint("Check for an iOS app update")
        DisclosureGroup("About server updates") {
          Text(
            "Your server and bot computer update together. Files, installed software and browser sign-ins stay in place. Open browser tabs close during the restart."
          ).font(.subheadline).foregroundStyle(.secondary)
        }
      }
    }
    .tint(.blue)
    .navigationTitle("Updates").navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if !model.updating {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            Task { await model.refresh(store) }
          } label: {
            if model.checking {
              ProgressView()
            } else {
              Image(systemName: "arrow.clockwise")
                .symbolRenderingMode(.palette)
                .foregroundStyle(colorScheme == .dark ? Color.white : Color.black)
            }
          }.tint(colorScheme == .dark ? Color.white : Color.black).disabled(model.checking)
            .accessibilityLabel(
              "Check for updates"
            )
            .accessibilityIdentifier("server-update-check")
        }
      }
    }
    .alert("Update your server?", isPresented: $confirming) {
      Button("Update server") {
        Task { await model.start(store) }
      }.accessibilityIdentifier("server-update-confirm")
      Button("Not now", role: .cancel) {}.accessibilityIdentifier("server-update-cancel")
    } message: {
      Text(
        "Install \(model.policy.targetVersion ?? model.clientVersion) on \(host)? Your server and bot computer will restart briefly. Your files and sign-ins stay in place."
      )
    }
    .task(id: scenePhase) {
      guard scenePhase == .active else { return }
      while !Task.isCancelled {
        await model.refresh(store)
        do {
          try await Task.sleep(
            for: .seconds(
              model.updating || model.policy.targetVersion != nil || model.release == nil
                || model.reconnecting ? 2 : 60))
        } catch { return }
      }
    }
    .refreshable { await model.refresh(store) }
  }

  @ViewBuilder private var serverActions: some View {
    if healthy {
      Label("You're up to date", systemImage: "checkmark.circle.fill")
        .foregroundStyle(.green)
    }
    if let target = model.policy.targetVersion {
      if !model.busyNames.isEmpty {
        Label(
          "Waiting for " + model.busyNames.joined(separator: ", ")
            + ". The update is available when every bot is done.", systemImage: "clock"
        ).foregroundStyle(.secondary)
      }
      if model.update?.updaterAvailable == true {
        Button("Update to \(target)") { confirming = true }
          .buttonStyle(.borderedProminent)
          .foregroundStyle(.white)
          .disabled(!model.canUpdate)
          .accessibilityIdentifier("server-update-start")
          .frame(maxWidth: .infinity)
      } else {
        VStack(alignment: .leading, spacing: 6) {
          Text("Enable updates on your server").font(.headline)
          Text("Run this once on the server computer:").foregroundStyle(.secondary)
          Text("openteam update --version \(target)").font(.callout.monospaced())
            .textSelection(.enabled)
        }
      }
    }
  }

  @ViewBuilder private var progressRows: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 12) {
        ProgressView().controlSize(.small)
        Text(model.reconnecting ? "Reconnecting to the server…" : progress.title)
          .font(.subheadline.weight(.semibold))
      }
      if model.reconnecting {
        Text("Last seen: \(progress.title)").font(.caption).foregroundStyle(.secondary)
      } else if let message = model.update?.message, !message.isEmpty {
        Text(message).font(.caption).foregroundStyle(.secondary)
      }
      if progress.rollingBack {
        Text("Recovering safely").font(.caption).foregroundStyle(.orange)
      } else if progress.step == nil {
        Text("Live progress").font(.caption).foregroundStyle(.secondary)
      }
      if let step = progress.step {
        ProgressView(value: Double(min(step, 5)), total: 5)
          .accessibilityLabel("Update stages")
          .accessibilityValue("\(min(step, 5)) of 5 stages complete")
        HStack {
          Text("Step \(min(step + 1, 5)) of 5")
          Spacer()
          if let started = model.startedAt {
            Text(started, style: .timer).monospacedDigit()
              .accessibilityLabel("Time since update started")
          }
        }.font(.caption).foregroundStyle(.secondary)
      }
    }.padding(.vertical, 6).accessibilityIdentifier("server-update-progress")

    if !progress.rollingBack, let step = progress.step {
      DisclosureGroup("Update stages") {
        ForEach(Array(ServerUpdateProgress.steps.enumerated()), id: \.offset) { index, title in
          Label {
            HStack {
              Text(title)
              Spacer()
              if index < step {
                Text("Done").foregroundStyle(.secondary)
              }
            }
          } icon: {
            Image(
              systemName: index < step
                ? "checkmark.circle.fill" : index == step ? "circle.inset.filled" : "circle"
            )
            .foregroundStyle(
              index < step ? Color.green : index == step ? Color.accentColor : Color.secondary)
          }
        }
      }
    }
  }

  private var progressFooter: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(
        model.reconnecting
          ? "Your server is restarting. We'll reconnect automatically."
          : model.update?.safeToCloseDesktop == true
            ? "You can close the app. The update will keep going."
            : "Keep this screen open while the update starts."
      )
      if model.reconnecting, let observed = model.observedAt {
        Text("Last checked \(observed, style: .relative) ago.")
      }
    }.font(.footnote).foregroundStyle(.secondary)
  }

  @ViewBuilder private var statusCopy: some View {
    switch model.policy.compatibility {
    case .unknown: Text("Could not verify the server version. Check for updates again.")
    case .clientRequired: Text("Update the iOS app to match this server.")
    case .serverRequired: Text("Update the server to support this iOS app.")
    case .recommended:
      Text(
        model.policy.targetVersion == nil
          ? "This server is newer than the installed iOS app."
          : "Your server and bot computer will restart briefly.")
    case .compatible:
      Text("Your server matches iOS app \(model.clientVersion).")
    }
  }
}
