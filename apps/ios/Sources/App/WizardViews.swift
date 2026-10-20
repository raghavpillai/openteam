import SwiftUI

// The first-run wizard is built from system pieces: each step is a NavigationStack
// page (system push, edge swipe and back chevron), headlines use text styles,
// options are inset-grouped rows, and the main button is a prominent system button
// pinned to the bottom. The stage tint, mesh and robot art live in the wizard's
// backdrop (WizardBackdrop.swift), behind the pages, so they carry across steps.

extension WizardStage {
  /// The soft background behind each stage's illustration.
  var tint: Color {
    switch self {
    case .server: return NativePalette.color("E8F0FE", "0F1B2E")
    case .model: return NativePalette.color("EFEAFF", "1B1631")
    case .voice: return NativePalette.color("FFEFE2", "2A1B0E")
    case .bot: return NativePalette.color("E4F5EA", "0E2417")
    }
  }
  /// The stage's highlight color inside illustrations and selected rows.
  var accent: Color {
    switch self {
    case .server: return NativePalette.color("2F6FEB", "6B9BFF")
    case .model: return NativePalette.color("7C4DFF", "A285FF")
    case .voice: return NativePalette.color("F0701A", "FF8F45")
    case .bot: return NativePalette.color("1E9E57", "3FD083")
    }
  }
}

/// Semantic colors for the wizard, so both appearances follow the system.
enum WizardPalette {
  static let page = Color(uiColor: .systemGroupedBackground)
  static let card = Color(uiColor: .secondarySystemGroupedBackground)
  static let cardBorder = Color(uiColor: .separator).opacity(0.5)
  static let secondary = Color(uiColor: .secondaryLabel)
  static let hairline = Color(uiColor: .separator)
  /// The dark panel behind a payoff moment (W5 "It works!").
  static let payoff = Color(hex: "141416")
  static let success = Color(uiColor: .systemGreen)
}

/// Whether the art should move: the app is in front and Reduce Motion is off. Art
/// pauses its timelines otherwise.
private struct WizardArtActiveKey: EnvironmentKey { static let defaultValue = true }
extension EnvironmentValues {
  var wizardArtActive: Bool {
    get { self[WizardArtActiveKey.self] }
    set { self[WizardArtActiveKey.self] = newValue }
  }
}

// MARK: - Focus

/// Owns a page's keyboard focus. A parent's `@FocusState` doesn't reach into
/// NavigationStack destinations, so each page hosts its own and mirrors `focus`.
/// Only the page on top syncs, so covered pages never steal or clear focus.
struct WizardFocusHost<Value: Hashable, Content: View>: View {
  @Binding var focus: Value?
  var isActive = true
  @ViewBuilder var content: (FocusState<Value?>.Binding) -> Content
  @FocusState private var state: Value?
  var body: some View {
    content($state)
      .onChange(of: focus) { _, value in
        guard isActive, state != value else { return }
        state = value
      }
      .onChange(of: state) { _, value in
        guard isActive, focus != value else { return }
        focus = value
      }
      .onChange(of: isActive) { _, active in if active { state = focus } }
      .onAppear { if isActive { state = focus } }
  }
}

// MARK: - Page

/// One wizard step: a transparent slot where the backdrop draws the art, the page's
/// text and controls on an opaque sheet below it, the stage strip in the navigation
/// bar, and the main button pinned to the bottom.
struct WizardPage<Content: View, Actions: View>: View {
  @Environment(\.dynamicTypeSize) private var typeSize
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(WizardBackdrop.self) private var backdrop: WizardBackdrop?
  let stage: WizardStage
  /// Whether this page is on top. Only that page places the art.
  var active = true
  var skip: (() -> Void)? = nil
  /// The id of the card holding the focused field, kept in view above the keyboard.
  var focusAnchor: String? = nil
  /// A summary of what the page shows; when it changes, the page springs to its new
  /// layout (rows and buttons arrive and leave with transitions, text blurs over).
  var motion: String = ""
  @ViewBuilder var content: () -> Content
  @ViewBuilder var actions: () -> Actions

  /// The status and navigation bars' height, so the mesh can run under them.
  @State private var topInset: CGFloat = 100
  /// How far the page is scrolled. It comes from the scroll view itself, not the
  /// page's position on screen, which UIKit moves around during a push. Held outside
  /// SwiftUI state: scrolling only moves the backdrop and never re-renders the page,
  /// so it can't disturb the keyboard's own scroll to the focused field.
  @State private var scroll = ScrollOffset()
  @State private var identity = UUID()
  /// False while the page is still pushing in.
  @State private var settled = false

  private final class ScrollOffset { var value: CGFloat = 0 }

  private var slot: WizardHeaderSlot {
    WizardHeaderSlot(minY: -scroll.value, bars: topInset, compact: typeSize.isAccessibilitySize)
  }
  private var spring: Animation? {
    guard settled else { return nil }
    return reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.45)
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          Color.clear.frame(height: slot.height).accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 18) { content() }
            .padding(.horizontal, 20).padding(.top, 22).padding(.bottom, 28)
            .frame(maxWidth: 600, alignment: .leading)
            .frame(maxWidth: .infinity)
            .animation(spring, value: motion)
            .background(alignment: .top) {
              // Opaque from the art down past the bottom edge, so a page pushing in
              // covers the one beneath it while the art behind both stays put.
              WizardPalette.page.frame(height: 4000)
            }
        }
      }
      .ignoresSafeArea(.container, edges: .top)
      .scrollBounceBehavior(.basedOnSize)
      .scrollDismissesKeyboard(.interactively)
      .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: {
        _, value in
        scroll.value = value
        if active { place() }
      }
      .onChange(of: focusAnchor) { _, anchor in reveal(anchor, proxy) }
      // Start as the keyboard starts, so the card rides up with it; check again once
      // it's fully up.
      .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) {
        _ in reveal(focusAnchor, proxy)
      }
      .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) {
        _ in reveal(focusAnchor, proxy)
      }
      .floatingBar(edge: .bottom) {
        VStack(spacing: 4) { actions() }
          .padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 6)
          .frame(maxWidth: 600).frame(maxWidth: .infinity)
          .animation(spring, value: motion)
      }
    }
    .background {
      // A reader under the bars reports their height as its top safe-area inset.
      GeometryReader { proxy in
        Color.clear
          .onAppear { if proxy.safeAreaInsets.top > 0 { topInset = proxy.safeAreaInsets.top } }
          .onChange(of: proxy.safeAreaInsets.top) { _, value in if value > 0 { topInset = value } }
      }
      .ignoresSafeArea()
    }
    .containerBackground(.clear, for: .navigation)
    .environment(\.wizardSettled, settled)
    .task {
      try? await Task.sleep(for: .milliseconds(reduceMotion ? 100 : 520))
      settled = true
    }
    .onChange(of: active, initial: true) { _, active in if active { place() } }
    .onChange(of: topInset) { _, _ in if active { place() } }
    .onChange(of: typeSize) { _, _ in if active { place() } }
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(.hidden, for: .navigationBar)
    .toolbar {
      ToolbarItem(placement: .principal) { WizardStageBar(current: stage) }
      if let skip {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Skip", action: skip).accessibilityIdentifier("wizard-skip")
        }
      }
    }
  }

  private func place() {
    backdrop?.place(slot, by: identity, reduceMotion: reduceMotion)
  }

  /// Scrolls the focused field's whole card into view once the keyboard is up.
  private func reveal(_ anchor: String?, _ proxy: ScrollViewProxy) {
    guard let anchor else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
      withAnimation(reduceMotion ? nil : .snappy(duration: 0.35)) {
        proxy.scrollTo(anchor, anchor: .bottom)
      }
    }
  }
}

// MARK: - Stage strip

/// Shared across pages, so a stage's segment fills once, when the stage begins.
@MainActor private enum WizardProgressMemory { static var shown = -1 }

/// Four thin segments (filled through the current stage) and the stage's name.
struct WizardStageBar: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let current: WizardStage
  @State private var fill: CGFloat = 1
  var body: some View {
    VStack(spacing: 5) {
      HStack(spacing: 4) {
        ForEach(WizardStage.allCases, id: \.self) { stage in
          Capsule().fill(Color.primary.opacity(0.14))
            .overlay(alignment: .leading) {
              GeometryReader { proxy in
                Capsule().fill(Color.primary)
                  .frame(
                    width: proxy.size.width
                      * (stage < current ? 1 : stage == current ? fill : 0))
              }
            }
            .frame(width: 26, height: 4)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(stage.title)
            .accessibilityValue(
              stage < current ? "Done" : stage == current ? "Current stage" : "Not started")
            .accessibilityIdentifier("wizard-stage-\(stage.rawValue + 1)")
        }
      }
      Text(current.title).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
        .accessibilityHidden(true)
    }
    .onAppear {
      guard current.rawValue > WizardProgressMemory.shown else { return }
      WizardProgressMemory.shown = current.rawValue
      guard !reduceMotion else { return }
      fill = 0
      withAnimation(.smooth(duration: 0.7).delay(0.2)) { fill = 1 }
    }
  }
}

// MARK: - Text

extension AnyTransition {
  /// Text replaced in place: the old line blurs up and away as the new one sharpens.
  @MainActor static func wizardText(_ reduceMotion: Bool) -> AnyTransition {
    reduceMotion ? .opacity : AnyTransition(.blurReplace(.upUp))
  }
}

/// Whether the page has finished arriving. Changes during a push land without
/// animation, so content never cross-fades while it slides.
private struct WizardSettledKey: EnvironmentKey { static let defaultValue = true }
extension EnvironmentValues {
  var wizardSettled: Bool {
    get { self[WizardSettledKey.self] }
    set { self[WizardSettledKey.self] = newValue }
  }
}

/// The page's headline and its one-line explanation, in system text styles. Each step
/// keeps one header: a new headline blurs over the old one in place, and an optional
/// accessory (a check) leads the title.
struct WizardHeader<Accessory: View>: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.wizardSettled) private var settled
  let title: String
  var detail: String? = nil
  var large = false
  /// The detail's identifier, when the line reports a result (such as the model test).
  var detailIdentifier = "wizard-detail"
  @ViewBuilder var accessory: () -> Accessory

  private var animation: Animation? {
    guard settled else { return nil }
    return reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.42)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .center, spacing: 12) {
        accessory()
        ZStack(alignment: .topLeading) {
          Text(title).font(large ? .largeTitle.bold() : .title.bold())
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .id(title)
            .transition(.wizardText(reduceMotion))
            .accessibilityAddTraits(.isHeader).accessibilityIdentifier("wizard-title")
        }
      }
      if let detail, !detail.isEmpty {
        ZStack(alignment: .topLeading) {
          Text(Self.styled(detail)).font(.body).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .id(detail)
            .transition(.wizardText(reduceMotion))
            .accessibilityIdentifier(detailIdentifier)
        }
        .transition(.wizardText(reduceMotion))
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .animation(animation, value: title)
    .animation(animation, value: detail)
  }
  /// Commands such as `openteam doctor` show as code; other text is shown as is.
  static func styled(_ text: String) -> AttributedString {
    guard text.contains("`"),
      let value = try? AttributedString(
        markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
    else { return AttributedString(text) }
    return value
  }
}

extension WizardHeader where Accessory == EmptyView {
  init(
    title: String, detail: String? = nil, large: Bool = false,
    detailIdentifier: String = "wizard-detail"
  ) {
    self.init(title: title, detail: detail, large: large, detailIdentifier: detailIdentifier) {
      EmptyView()
    }
  }
}

/// A small footnote under a group.
struct WizardFootnote: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let text: LocalizedStringKey
  init(_ text: LocalizedStringKey) { self.text = text }
  var body: some View {
    Text(text).font(.footnote).foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 16)
      .transition(.wizardText(reduceMotion))
  }
}

// MARK: - Grouped rows

/// An inset-grouped section: rounded rows on the grouped background, like Settings.
/// It arrives and leaves with the same blur as text.
struct WizardGroup<Content: View>: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var header: String? = nil
  var selected: Color? = nil
  @ViewBuilder var content: () -> Content
  var body: some View {
    group.transition(.wizardText(reduceMotion))
  }
  private var group: some View {
    VStack(alignment: .leading, spacing: 7) {
      if let header {
        Text(header).font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 16)
      }
      VStack(spacing: 0) { content() }
        .background(WizardPalette.card)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
          RoundedRectangle(cornerRadius: 22, style: .continuous)
            .strokeBorder(selected ?? .clear, lineWidth: 2).allowsHitTesting(false)
        }
    }
  }
}

/// A divider between rows, inset past the icon like a system list.
struct WizardDivider: View {
  var inset: CGFloat = 16
  var body: some View {
    Rectangle().fill(WizardPalette.hairline).frame(height: 1.0 / 3).padding(.leading, inset)
  }
}

/// A Settings-style icon: an SF Symbol on a colored rounded square.
struct WizardIcon: View {
  let symbol: String
  let color: Color
  var size: CGFloat = 30
  var body: some View {
    Image(systemName: symbol).font(.system(size: size * 0.5, weight: .semibold))
      .foregroundStyle(.white)
      .frame(width: size, height: size)
      .background(color.gradient, in: RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
      .accessibilityHidden(true)
  }
}

/// One row: icon (a symbol, or a provider's official icon), title and subtitle, and
/// whatever trails it.
struct WizardRow<Trailing: View>: View {
  var symbol: String? = nil
  var color: Color = .gray
  var provider: ProviderMark.Kind? = nil
  let title: String
  var subtitle: String? = nil
  @ViewBuilder var trailing: () -> Trailing
  var body: some View {
    HStack(spacing: 14) {
      if let provider {
        ProviderMark(kind: provider, size: 30, style: .icon)
      } else if let symbol {
        WizardIcon(symbol: symbol, color: color)
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.body).foregroundStyle(.primary)
        if let subtitle {
          Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 8)
      trailing()
    }
    .padding(.horizontal, 16).padding(.vertical, 11)
    .frame(minHeight: 54)
    .contentShape(Rectangle())
  }
}

extension WizardRow where Trailing == EmptyView {
  init(
    symbol: String? = nil, color: Color = .gray, provider: ProviderMark.Kind? = nil,
    title: String, subtitle: String? = nil
  ) {
    self.init(symbol: symbol, color: color, provider: provider, title: title, subtitle: subtitle) {
      EmptyView()
    }
  }
}

/// Highlights a tapped row the way a list cell does.
struct WizardRowButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(configuration.isPressed ? Color(uiColor: .systemGray4) : .clear)
  }
}

/// A text field row inside a group.
struct WizardFieldStyle: ViewModifier {
  func body(content: Content) -> some View {
    content.font(.body).padding(.horizontal, 16).frame(minHeight: 52)
  }
}

/// A segmented choice between providers, each with its official mark. The selection
/// slides between options on a spring.
struct WizardProviderChoice: View {
  struct Option: Identifiable, Equatable {
    let id: String
    let title: String
    let kind: ProviderMark.Kind
  }
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var typeSize
  let options: [Option]
  @Binding var selection: String
  let identifier: String
  var disabled = false
  @Namespace private var highlight

  var body: some View {
    let layout =
      typeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(spacing: 4)) : AnyLayout(HStackLayout(spacing: 4))
    layout {
      ForEach(options) { option in
        let selected = option.id == selection
        Button {
          guard !selected else { return }
          withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .snappy(duration: 0.35)) {
            selection = option.id
          }
        } label: {
          HStack(spacing: 7) {
            ProviderMark(kind: option.kind, size: 18)
            Text(option.title).font(.subheadline.weight(.semibold))
              .lineLimit(1).minimumScaleFactor(0.75)
          }
          .foregroundStyle(selected ? Color.primary : Color.secondary)
          .padding(.horizontal, 8)
          .frame(maxWidth: .infinity, minHeight: 40)
          .background {
            if selected {
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(WizardPalette.card)
                .shadow(color: .black.opacity(0.08), radius: 4, y: 2)
                .wizardShared("selection", in: reduceMotion ? nil : highlight)
            }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(option.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(identifier + "-" + option.id)
      }
    }
    .padding(4)
    .background(
      Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 16, style: .continuous)
    )
    .disabled(disabled)
    .opacity(disabled ? 0.6 : 1)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(identifier)
  }
}

// MARK: - Buttons

/// The full-width main button pinned to the bottom: Liquid Glass on iOS 26. Its label
/// morphs between states and a spinner slides in while it works.
struct WizardPrimaryButton: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let title: String
  var identifier = "wizard-continue"
  var symbol: String? = nil
  var busy = false
  var disabled = false
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 9) {
        if busy {
          PrimaryLoadingOrb(size: 20, label: "Working")
            .transition(.wizardText(reduceMotion).combined(with: .scale(scale: 0.6)))
        } else if let symbol {
          Image(systemName: symbol).fontWeight(.semibold)
            .transition(.wizardText(reduceMotion).combined(with: .scale(scale: 0.6)))
        }
        // Shared letters stay put; the ones that change roll over with a blur.
        Text(title).contentTransition(reduceMotion ? .opacity : .numericText())
      }
      .font(.headline)
      .foregroundStyle(NativePalette.onPrimary)
      .frame(maxWidth: .infinity, minHeight: 34)
    }
    .controlSize(.large)
    .tint(NativePalette.text)
    .modifier(ProminentButton())
    .disabled(disabled || busy)
    .animation(reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.45), value: title)
    .animation(reduceMotion ? .easeOut(duration: 0.2) : .snappy, value: busy)
    .transition(.wizardText(reduceMotion).combined(with: .offset(y: reduceMotion ? 0 : 14)))
    .accessibilityIdentifier(identifier)
  }
}

private struct ProminentButton: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 26, *) {
      content.buttonStyle(.glassProminent)
    } else {
      content.buttonStyle(.borderedProminent)
    }
  }
}

/// A plain text button under the main one, optionally with a muted second line.
struct WizardLink: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let title: String
  let identifier: String
  var detail: String? = nil
  var label: String? = nil
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      VStack(spacing: 2) {
        Text(title).font(.body.weight(.medium))
        if let detail {
          Text(detail).font(.footnote).foregroundStyle(.secondary)
        }
      }
      .multilineTextAlignment(.center)
      .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
    }
    .buttonStyle(.borderless)
    .transition(.wizardText(reduceMotion))
    .accessibilityLabel(label ?? ([title] + (detail.map { [$0] } ?? [])).joined(separator: ". "))
    .accessibilityIdentifier(identifier)
  }
}

// MARK: - Feedback and motion

/// Plays system haptics through `sensoryFeedback`, unless Haptics is off in Settings.
struct WizardFeedback<Trigger: Equatable>: ViewModifier {
  @AppStorage("haptics") private var haptics = true
  let feedback: SensoryFeedback
  let trigger: Trigger
  var when: (Trigger) -> Bool = { _ in true }
  func body(content: Content) -> some View {
    content.sensoryFeedback(trigger: trigger) { _, new in
      haptics && when(new) ? feedback : nil
    }
  }
}

extension View {
  func wizardFeedback<T: Equatable>(
    _ feedback: SensoryFeedback, trigger: T, when: @escaping (T) -> Bool = { _ in true }
  ) -> some View {
    modifier(WizardFeedback(feedback: feedback, trigger: trigger, when: when))
  }
  /// Shakes side to side when `trigger` changes (a cross-fade-free nudge for errors).
  func wizardShake<T: Equatable>(on trigger: T) -> some View {
    modifier(ShakeOnChange(trigger: trigger))
  }
}

private struct ShakeOnChange<T: Equatable>: ViewModifier {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let trigger: T
  @State private var shakes: CGFloat = 0
  func body(content: Content) -> some View {
    content.modifier(ShakeEffect(shakes: shakes))
      .onChange(of: trigger) { _, _ in
        guard !reduceMotion else { return }
        withAnimation(.smooth(duration: 0.5)) { shakes += 1 }
      }
  }
}

private struct ShakeEffect: GeometryEffect {
  var shakes: CGFloat
  var animatableData: CGFloat {
    get { shakes }
    set { shakes = newValue }
  }
  func effectValue(size: CGSize) -> ProjectionTransform {
    let progress = shakes - shakes.rounded(.down)
    let offset = 7 * sin(progress * .pi * 6) * (1 - progress)
    return ProjectionTransform(CGAffineTransform(translationX: offset, y: 0))
  }
}

/// A green circle whose checkmark draws itself in.
struct WizardCheck: View {
  var size: CGFloat = 64
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var drawn: CGFloat = 0
  @State private var shown = false
  var body: some View {
    ZStack {
      Circle().fill(WizardPalette.success.gradient)
      CheckmarkShape().trim(from: 0, to: drawn)
        .stroke(
          Color.white,
          style: StrokeStyle(lineWidth: max(2, size * 0.09), lineCap: .round, lineJoin: .round)
        )
        .padding(size * 0.28)
    }
    .frame(width: size, height: size)
    .scaleEffect(shown ? 1 : 0.4).opacity(shown ? 1 : 0)
    .onAppear {
      guard !reduceMotion else {
        withAnimation(.easeOut(duration: 0.2)) {
          shown = true
          drawn = 1
        }
        return
      }
      withAnimation(.bouncy(duration: 0.45, extraBounce: 0.15)) { shown = true }
      withAnimation(.smooth(duration: 0.4).delay(0.12)) { drawn = 1 }
    }
    .accessibilityHidden(true)
  }
}

struct CheckmarkShape: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    path.move(to: CGPoint(x: rect.minX, y: rect.midY + rect.height * 0.04))
    path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.37, y: rect.maxY - rect.height * 0.1))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + rect.height * 0.12))
    return path
  }
}

/// Confetti that bursts out of a point each time `trigger` changes, after `delay`.
struct CelebrationBurst: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var trigger: Int
  var colors: [Color]
  var radius: CGFloat = 92
  var delay: Double = 0
  private struct Spark {
    var distance: CGFloat = 0
    var scale: CGFloat = 0.3
    var opacity: Double = 0
    var spin: Double = 0
  }
  var body: some View {
    ZStack {
      if !reduceMotion {
        ForEach(0..<18, id: \.self) { index in
          let angle = Double(index) / 18 * 2 * .pi + (index.isMultiple(of: 2) ? 0.12 : -0.08)
          let reach = radius * (0.7 + 0.45 * CGFloat((index * 37) % 10) / 10)
          Group {
            if index.isMultiple(of: 3) {
              Image(systemName: "sparkle").font(.system(size: 13, weight: .bold))
            } else {
              RoundedRectangle(cornerRadius: 2).frame(width: 7, height: index.isMultiple(of: 2) ? 11 : 7)
            }
          }
          .foregroundStyle(colors[index % colors.count])
          .keyframeAnimator(initialValue: Spark(), trigger: trigger) { view, spark in
            view.rotationEffect(.degrees(spark.spin))
              .scaleEffect(spark.scale)
              .offset(x: cos(angle) * spark.distance, y: sin(angle) * spark.distance)
              .opacity(spark.opacity)
          } keyframes: { _ in
            KeyframeTrack(\.distance) {
              MoveKeyframe(0)
              CubicKeyframe(0, duration: max(0.01, delay))
              SpringKeyframe(reach, duration: 0.75, spring: .bouncy)
            }
            KeyframeTrack(\.scale) {
              MoveKeyframe(0.3)
              CubicKeyframe(0.3, duration: max(0.01, delay))
              CubicKeyframe(1.15, duration: 0.25)
              CubicKeyframe(0.7, duration: 0.6)
            }
            KeyframeTrack(\.opacity) {
              MoveKeyframe(0)
              CubicKeyframe(0, duration: max(0.01, delay))
              CubicKeyframe(1, duration: 0.05)
              CubicKeyframe(1, duration: 0.5)
              CubicKeyframe(0, duration: 0.4)
            }
            KeyframeTrack(\.spin) {
              MoveKeyframe(0)
              CubicKeyframe(0, duration: max(0.01, delay))
              CubicKeyframe(Double(index % 2 == 0 ? 160 : -140), duration: 0.9)
            }
          }
        }
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

/// A one-line status with a pulsing symbol while waiting, or a drawn check. New text
/// blurs over the old.
struct WizardStatusLine: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let text: String
  var done = false
  var symbol = "ellipsis"
  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      ZStack {
        if done {
          WizardCheck(size: 22)
        } else {
          Image(systemName: symbol).font(.body.weight(.semibold))
            .foregroundStyle(.secondary)
            .symbolEffect(.variableColor.iterative.reversing, options: .repeating)
        }
      }
      .frame(width: 26)
      ZStack(alignment: .leading) {
        Text(text).font(.subheadline.weight(done ? .medium : .regular))
          .foregroundStyle(done ? .primary : .secondary)
          .fixedSize(horizontal: false, vertical: true)
          .id(text)
          .transition(.wizardText(reduceMotion))
      }
    }
    .animation(.smooth, value: done)
    .animation(.smooth(duration: 0.35), value: text)
    .accessibilityElement(children: .combine)
  }
}

/// Inline error text that shakes in with an error haptic.
struct WizardError: View {
  let message: String
  var identifier = "wizard-error"
  /// Sign-in errors already play the app's error haptic.
  var haptic = true
  var body: some View {
    Label {
      Text(message).fixedSize(horizontal: false, vertical: true)
    } icon: {
      Image(systemName: "exclamationmark.circle.fill")
    }
    .font(.subheadline).foregroundStyle(.red)
    .padding(.horizontal, 4)
    .wizardShake(on: message)
    .wizardFeedback(.error, trigger: message, when: { _ in haptic })
    .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .top)))
    .accessibilityIdentifier(identifier)
  }
}

/// Lays out chips left to right, wrapping onto new lines.
struct WizardFlowLayout: Layout {
  var spacing: CGFloat = 8
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0
    var y: CGFloat = 0
    var row: CGFloat = 0
    var widest: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(ProposedViewSize(width: width, height: nil))
      if x > 0, x + size.width > width {
        x = 0
        y += row + spacing
        row = 0
      }
      x += size.width + spacing
      row = max(row, size.height)
      widest = max(widest, x - spacing)
    }
    return CGSize(width: proposal.width ?? widest, height: y + row)
  }
  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) {
    var x = bounds.minX
    var y = bounds.minY
    var row: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
      if x > bounds.minX, x + size.width > bounds.maxX {
        x = bounds.minX
        y += row + spacing
        row = 0
      }
      view.place(
        at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: size.width, height: size.height))
      x += size.width + spacing
      row = max(row, size.height)
    }
  }
}
