import SwiftUI

struct BrowserNetworkSettingsView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  @State private var view: BrowserNetworkView?
  @State private var draft: [String]?
  @State private var draftRevision: Int?
  @State private var operation = FormOperation()
  @State private var confirming = false
  @State private var egress: BrowserNetworkEgress?
  @State private var egressFailed = false
  @State private var quality: BrowserNetworkQuality?
  @State private var testing = false
  @State private var qualityFailed = false
  private var order: [String] { draft ?? view?.order ?? ["server"] }
  private var dirty: Bool { draft != nil && draft != view?.order }

  private var live: Bool { ["ready", "server"].contains(view?.runtime.state ?? "") }
  private var activeID: String? { view?.runtime.state == "server" ? "server" : view?.runtime.activeMachineId }
  private var activeName: String { view.map { $0.name(activeID ?? "") } ?? "Connecting…" }

  var body: some View {
    NativeList {
      if let view {
        Section("Browser network") {
          LabeledContent("Connection", value: live ? activeName : view.summary)
            .accessibilityElement(children: .ignore).accessibilityLabel(view.summary)
            .accessibilityIdentifier("network-status")
          ForEach(Array(order.enumerated()), id: \.element) { index, id in
            HStack(spacing: 10) {
              Text("\(index + 1)").font(.caption.monospacedDigit())
                .foregroundStyle(.secondary).frame(width: 12)
              Image(systemName: id == "server" ? "server.rack" : view.name(id).localizedCaseInsensitiveContains("mini") ? "macmini" : "laptopcomputer")
                .font(.body).foregroundStyle(.secondary).frame(width: 22)
              Text(view.name(id)).accessibilityIdentifier("network-source-\(id)")
              Spacer(minLength: 4)
              HStack(spacing: 4) {
                Circle().fill(view.working(id) ? Color.green : Color.secondary).frame(width: 5, height: 5)
                  .accessibilityHidden(true)
                Text(activeID == id && live ? "In use" : view.working(id) ? "Working" : "Not working")
                  .font(.caption.weight(activeID == id && live ? .medium : .regular))
              }.foregroundStyle(activeID == id && live ? .primary : .secondary)
                .padding(.horizontal, activeID == id && live ? 7 : 0)
                .padding(.vertical, activeID == id && live ? 3 : 0)
                .background(.primary.opacity(activeID == id && live ? 0.055 : 0), in: Capsule())
                .accessibilityLabel(activeID == id && live ? "Working, In use" : view.working(id) ? "Working" : "Not working")
                .accessibilityIdentifier("network-working-\(id)")
            }.moveDisabled(operation.busy)
              .contextMenu {
                Button("Move up", systemImage: "arrow.up") { move(id, by: -1) }.disabled(index == 0 || operation.busy)
                Button("Move down", systemImage: "arrow.down") { move(id, by: 1) }.disabled(index == order.count - 1 || operation.busy)
              }
              .accessibilityAction(named: "Move up") { move(id, by: -1) }
              .accessibilityAction(named: "Move down") { move(id, by: 1) }
          }.onMove { from, to in
            guard !operation.busy else { return }
            var next = order
            next.move(fromOffsets: from, toOffset: to)
            edit(next)
          }
        }
        Section {
          if live, let egress, egress.epoch == view.runtime.routeEpoch {
            PrivateNetworkValue(label: "Exit IP", value: egress.ip).id("ip-\(egress.epoch)-\(egress.ip)")
            PrivateNetworkValue(label: "Location", value: egress.location).id("location-\(egress.epoch)-\(egress.location)")
          } else {
            LabeledContent("Exit IP", value: !live || egressFailed ? "Unavailable" : "Checking…")
            LabeledContent("Location", value: !live || egressFailed ? "Unavailable" : "Checking…")
          }
          Button { Task { await testConnection() } } label: {
            HStack {
              Text("Connection test")
              Spacer()
              if testing { ProgressView() } else { Text("Test").foregroundStyle(NativePalette.link) }
            }.frame(maxWidth: .infinity, minHeight: 26).contentShape(Rectangle())
          }.buttonStyle(.plain).disabled(!live || testing)
            .accessibilityElement(children: .ignore).accessibilityAddTraits(.isButton)
            .accessibilityLabel(testing ? "Testing connection" : "Test active connection")
            .accessibilityIdentifier("network-quality-test")
          if live, let quality, quality.epoch == view.runtime.routeEpoch {
            HStack {
              Text("\(quality.latencyMs) ms").accessibilityLabel("Latency \(quality.latencyMs) milliseconds")
              Spacer()
              Label("~\(quality.downloadMbps.formatted(.number.precision(.fractionLength(1)))) Mbps", systemImage: "arrow.down")
              Spacer()
              Label("~\(quality.uploadMbps.formatted(.number.precision(.fractionLength(1)))) Mbps", systemImage: "arrow.up")
            }.font(.caption).foregroundStyle(.secondary).monospacedDigit()
              .accessibilityIdentifier("network-quality-result")
          } else if qualityFailed { Text("Test unavailable").foregroundStyle(.secondary) }
        }
        if dirty {
          Section { Button("Discard changes") { draft = nil; draftRevision = nil }
            .accessibilityIdentifier("network-discard").foregroundStyle(NativePalette.muted) }
        }
        if operation.failure != nil { Section { FormStatus(operation: operation) } }
        Section { NavigationLink("Server status") { ServerStatusView() }.environment(\.editMode, .constant(.inactive)) }
      } else {
        Section {
          FormStatus(operation: operation)
          if operation.failure != nil { Button("Retry") { Task { await load() } } }
        }
      }
    }.environment(\.editMode, .constant(.active))
      .listStyle(.insetGrouped).listSectionSpacing(20)
      .navigationTitle("Server").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Apply") { confirming = true }.fontWeight(.semibold)
            .disabled(!dirty || operation.busy).accessibilityIdentifier("network-apply")
        }
      }
      .onChange(of: view?.runtime.routeEpoch) { _, _ in quality = nil; qualityFailed = false }
      .task(id: scenePhase) {
        guard scenePhase == .active else { return }
        repeat {
          await load()
          try? await Task.sleep(for: .seconds(3))
        } while !Task.isCancelled
      }
      .task(id: "\(view?.runtime.routeEpoch ?? "")-\(view?.runtime.state ?? "")-\(scenePhase)") {
        egress = nil
        egressFailed = false
        guard scenePhase == .active, let epoch = view?.runtime.routeEpoch, live else { return }
        repeat {
          do {
            let result = try await store.request(BrowserNetworkRequest.path + "/egress", method: "POST", body: .object([:]))
            let value = try result.decode(BrowserNetworkEgress.self)
            if !Task.isCancelled && value.epoch == epoch { egress = value; egressFailed = false }
          } catch { if !Task.isCancelled { egress = nil; egressFailed = true } }
          try? await Task.sleep(for: .seconds(120))
        } while !Task.isCancelled
      }
      .confirmationDialog("Apply connection priority?", isPresented: $confirming, titleVisibility: .visible) {
        Button("Apply priority") { Task { await apply() } }
      } message: {
        Text("Changing the active connection interrupts browser downloads and connections. Pages stay open; requests are not replayed.")
      }
  }
  private func testConnection() async {
    guard let epoch = view?.runtime.routeEpoch, live, !testing else { return }
    testing = true
    qualityFailed = false
    defer { testing = false }
    do {
      let result = try await store.request(BrowserNetworkRequest.path + "/quality", method: "POST", body: .object([:]))
      let value = try result.decode(BrowserNetworkQuality.self)
      if view?.runtime.routeEpoch == epoch && value.epoch == epoch { quality = value }
    } catch {
      if view?.runtime.routeEpoch == epoch { quality = nil; qualityFailed = true }
    }
  }
  private func edit(_ next: [String]) {
    if draftRevision == nil { draftRevision = view?.settings.revision }
    draft = next
  }
  private func move(_ id: String, by delta: Int) {
    guard let from = order.firstIndex(of: id), order.indices.contains(from + delta), !operation.busy else { return }
    var next = order
    next.swapAt(from, from + delta)
    edit(next)
  }
  private func load() async {
    guard !operation.busy else { return }
    do {
      view = try await store.fetch(BrowserNetworkRequest.path, as: BrowserNetworkView.self)
    } catch {
      if view == nil { await operation.run(feedback: false) { throw error } }
    }
  }
  private func apply() async {
    guard let view, dirty else { return }
    await operation.run {
      do {
        let result = try await store.request(BrowserNetworkRequest.path, method: "PATCH",
          body: BrowserNetworkRequest.priority(order, revision: draftRevision ?? view.settings.revision))
        self.view = try result.decode(BrowserNetworkView.self)
        draft = nil
        draftRevision = nil
      } catch {
        if (error as? APIError)?.status == 409 {
          draft = nil; draftRevision = nil
          self.view = try? await store.fetch(BrowserNetworkRequest.path, as: BrowserNetworkView.self)
        }
        throw error
      }
    }
  }
}

private struct PrivateNetworkValue: View {
  @Environment(\.scenePhase) private var scenePhase
  let label: String
  let value: String
  @State private var revealed = false
  var body: some View {
    Button { revealed.toggle() } label: {
      LabeledContent(label) {
        Text(value).foregroundStyle(.secondary).blur(radius: revealed ? 0 : 5)
          .accessibilityHidden(true)
      }.frame(maxWidth: .infinity, minHeight: 32).contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityElement(children: .ignore).accessibilityAddTraits(.isButton)
      .accessibilityLabel("\(revealed ? "Hide" : "Reveal") \(label.lowercased())")
      .accessibilityValue(revealed ? value : "Hidden")
      .accessibilityIdentifier("network-private-\(label)")
      .onChange(of: scenePhase) { _, phase in if phase != .active { revealed = false } }

  }
}
