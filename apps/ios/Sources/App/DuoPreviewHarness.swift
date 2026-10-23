#if DEBUG
  import SwiftUI

  /// QA stand-in for an iPhone Duo while Xcode 26 has no Duo simulator. Launched
  /// with `--duo-preview` on an iPad simulator, it frames the app at the Duo's
  /// screen sizes in points (1398×2034 outer and 1878×2670 inner pixels at 3×),
  /// with each display's size classes and the outer display's side status region.
  struct DuoPreviewHarness<Content: View>: View {
    enum Posture: String, CaseIterable, Identifiable {
      case folded, unfolded, landscape
      var id: Self { self }
      var size: CGSize {
        switch self {
        case .folded: CGSize(width: 466, height: 678)
        case .unfolded: CGSize(width: 626, height: 890)
        case .landscape: CGSize(width: 890, height: 626)
        }
      }
      var title: String {
        switch self {
        case .folded: "Folded"
        case .unfolded: "Unfolded"
        case .landscape: "Landscape"
        }
      }
      /// Apple's iPhone Duo guidance: the outer display has iPhone size classes;
      /// the inner one is regular in both dimensions in every orientation.
      var horizontalSizeClass: UIUserInterfaceSizeClass {
        self == .folded ? .compact : .regular
      }
      /// The outer display's status bar and Dynamic Island sit down its right side.
      var insets: UIEdgeInsets {
        switch self {
        // Measured from a folded iPhone Duo screenshot: an 84-point side region.
        case .folded: UIEdgeInsets(top: 8, left: 0, bottom: 20, right: 84)
        case .unfolded: UIEdgeInsets(top: 32, left: 0, bottom: 20, right: 0)
        case .landscape: UIEdgeInsets(top: 12, left: 0, bottom: 20, right: 0)
        }
      }
      var caption: String {
        switch self {
        case .folded: "5.4″ outer display · 466 × 678 pt"
        case .unfolded: "7.6″ inner display · 626 × 890 pt"
        case .landscape: "7.6″ inner display · 890 × 626 pt"
        }
      }
    }
    @State private var posture: Posture = {
      let args = ProcessInfo.processInfo.arguments
      guard let index = args.firstIndex(of: "--duo-posture"), args.indices.contains(index + 1)
      else { return .folded }
      return Posture(rawValue: args[index + 1]) ?? .folded
    }()
    @Environment(AppStore.self) private var store
    @ViewBuilder var content: Content
    var body: some View {
      let size = posture.size
      VStack(spacing: 22) {
        Spacer(minLength: 0)
        // Navigation stacks read UIKit safe areas, which SwiftUI padding cannot add.
        SafeAreaHost(
          root: AnyView(
            content.environment(store)
              .foregroundStyle(NativePalette.text, NativePalette.muted, NativePalette.faint)),
          insets: posture.insets, horizontalSizeClass: posture.horizontalSizeClass
        )
          .frame(width: size.width, height: size.height)
          .clipShape(RoundedRectangle(cornerRadius: 36, style: .continuous))
          .overlay(alignment: .topTrailing) {
            if posture == .folded {
              // The status block atop the side region: camera, time, connectivity.
              VStack(spacing: 14) {
                Circle().fill(.black).frame(width: 13, height: 13).padding(.top, 22)
                Image(systemName: "location.fill").font(.system(size: 15, weight: .semibold))
                  .padding(.top, 12)
                Text("9:41").font(.system(size: 19, weight: .bold)).padding(.top, -6)
                Image(systemName: "wifi").font(.system(size: 17, weight: .semibold))
              }.foregroundStyle(.black).frame(width: 84).allowsHitTesting(false)
            }
          }
          .overlay {
            // The inner display folds across its long axis.
            if posture != .folded {
              LinearGradient(
                colors: [.clear, .black.opacity(0.035), .clear],
                startPoint: posture == .unfolded ? .leading : .top,
                endPoint: posture == .unfolded ? .trailing : .bottom
              )
              .frame(
                width: posture == .unfolded ? 18 : nil, height: posture == .landscape ? 18 : nil
              )
              .allowsHitTesting(false)
            }
          }
          .padding(9)
          .background(
            RoundedRectangle(cornerRadius: 45, style: .continuous).fill(Color(white: 0.1))
              .overlay(
                RoundedRectangle(cornerRadius: 45, style: .continuous)
                  .stroke(Color(white: 0.32), lineWidth: 1.5))
          )
        VStack(spacing: 10) {
          HStack(spacing: 8) {
            ForEach(Posture.allCases) { option in
              Button(option.title) {
                withAnimation(.spring(duration: 0.55, bounce: 0.12)) { posture = option }
              }
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(posture == option ? Color.black : Color.white)
              .padding(.horizontal, 16).frame(height: 36)
              .background(posture == option ? Color.white : Color(white: 0.2), in: Capsule())
              .buttonStyle(.plain).accessibilityIdentifier("duo-" + option.rawValue)
            }
          }
          Text("iPhone Duo · " + posture.caption).font(.footnote)
            .foregroundStyle(Color(white: 0.6)).contentTransition(.opacity)
        }
        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color.black)
      .ignoresSafeArea()
      .statusBarHidden()
      .persistentSystemOverlays(.hidden)
    }
  }

  private struct SafeAreaHost: UIViewControllerRepresentable {
    var root: AnyView
    var insets: UIEdgeInsets
    var horizontalSizeClass: UIUserInterfaceSizeClass
    func makeUIViewController(context: Context) -> UIHostingController<AnyView> {
      let controller = UIHostingController(rootView: root)
      controller.view.backgroundColor = .clear
      updateUIViewController(controller, context: context)
      return controller
    }
    func updateUIViewController(_ controller: UIHostingController<AnyView>, context: Context) {
      controller.rootView = root
      controller.additionalSafeAreaInsets = insets
      controller.traitOverrides.horizontalSizeClass = horizontalSizeClass
      controller.traitOverrides.verticalSizeClass = .regular
    }
  }
#endif
