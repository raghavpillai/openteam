import SwiftUI
import ThinkingOrbsKit

/// The app's indeterminate progress indicator: a thinking orb in place of a spinner.
///
/// Every loading orb uses the same `composing` state. `size` is the spinner's old point size
/// (regular 20, small 16, mini 12); the orb draws the nearest tuned preset at that size.
/// Pin `theme` to the opposite scheme on inverted surfaces such as a filled primary button.
/// Bot activity keeps its own indicators (the robot, the activity footer).
struct LoadingOrb: View {
  var size: CGFloat = 20
  var theme: OrbTheme = .auto
  var label: String?

  var body: some View {
    // One element that carries the caller's label and identifier, like ProgressView did.
    ZStack {
      ThinkingOrb(state: .composing, size: size > 40 ? .px64 : .px20, theme: theme, displaySize: Double(size))
    }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(label ?? "Loading")
      .accessibilityAddTraits(.updatesFrequently)
  }
}

/// A loading orb on a filled primary button, which is black in light mode and white in dark mode.
struct PrimaryLoadingOrb: View {
  @Environment(\.colorScheme) private var colorScheme
  var size: CGFloat = 16
  var label: String?

  var body: some View {
    LoadingOrb(size: size, theme: colorScheme == .dark ? .light : .dark, label: label)
  }
}

/// `ProgressView("Loading…")` with an orb beside its label.
struct LoadingOrbLabel: View {
  let title: String

  var body: some View {
    HStack(spacing: 10) {
      LoadingOrb(size: 20).accessibilityHidden(true)
      Text(title).foregroundStyle(NativePalette.muted)
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(title)
  }
}
