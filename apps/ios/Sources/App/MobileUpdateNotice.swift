import SwiftUI

struct MobileUpdateBadge: View {
  @Environment(MobileUpdates.self) private var updates
  var body: some View {
    if updates.availableRelease != nil {
      Button {
        Task { await updates.openTestFlight() }
      } label: {
        Label("Update", systemImage: "arrow.up")
          .font(.system(size: 12, weight: .semibold))
          .padding(.horizontal, 10).frame(minHeight: 32)
          .foregroundStyle(.white).background(NativePalette.link, in: Capsule())
          .frame(minHeight: 44)
      }.buttonStyle(.plain)
        .disabled(updates.openingTestFlight)
        .accessibilityLabel("Update available. Open TestFlight")
        .accessibilityIdentifier("mobile-update-badge")
    }
  }
}

struct MobileUpdateNotice: View {
  @Environment(MobileUpdates.self) private var updates
  var body: some View {
    if let release = updates.availableRelease {
      VStack(alignment: .leading, spacing: 14) {
        HStack(spacing: 12) {
          Image(systemName: "arrow.down.to.line")
            .font(.system(size: 17, weight: .medium)).foregroundStyle(NativePalette.link)
            .frame(width: 38, height: 38)
            .background(NativePalette.link.opacity(0.1), in: RoundedRectangle(cornerRadius: 11))
          VStack(alignment: .leading, spacing: 3) {
            Text("Update available").font(.subheadline.weight(.semibold))
            Text("OpenTeam \(release.version) · Build \(release.buildNumber)")
              .font(.caption).foregroundStyle(NativePalette.muted)
          }
        }
        Button {
          Task { await updates.openTestFlight() }
        } label: {
          HStack(spacing: 6) {
            Text("Update in TestFlight").foregroundStyle(.white)
            Image(systemName: "arrow.up.right").foregroundStyle(.white)
          }.font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(.white)
            .background(NativePalette.link, in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain).disabled(updates.openingTestFlight)
          .accessibilityIdentifier("mobile-update-testflight")
        if let error = updates.openError {
          Text(error).font(.footnote).foregroundStyle(.red).accessibilityAddTraits(
            .updatesFrequently)
        }
      }.padding(.vertical, 6)
    }
  }
}
