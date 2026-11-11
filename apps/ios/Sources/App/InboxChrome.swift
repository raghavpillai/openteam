import SwiftUI
import UIKit

/// Keep the same semantic slots on every page. NavigationStack owns their
/// backgrounds and the interactive transition, including a cancelled pop.
/// On iOS 27.1 the system moves these bars beside Duo's status area; on a
/// conventional iPhone they remain horizontal. No device-size guesses needed.
enum InboxChrome {
  static let primaryAction = "inbox.primary-action"
  static let secondaryAction = "inbox.secondary-action"
  static let title = "inbox.title"
  // A raster template keeps UIKit from replacing the measured symbol size
  // with the navigation bar's default search-image configuration.
  @MainActor static let searchImage = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { _ in
    UIImage(systemName: "magnifyingglass", withConfiguration:
      UIImage.SymbolConfiguration(pointSize: 20, weight: .regular))?
      // Account for the symbol image's intrinsic transparent margins. The
      // visible ink is 18 points square within the 20-point template canvas.
      .draw(in: CGRect(x: -1.7, y: -0.95, width: 23.4, height: 21.9))
  }.withRenderingMode(.alwaysTemplate)
  @MainActor static let pluginsImage = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { _ in
    let path = UIBezierPath()
      for rect in [CGRect(x: 1, y: 1, width: 6.5, height: 6.5),
        CGRect(x: 11.5, y: 1, width: 6.5, height: 6.5),
        CGRect(x: 1, y: 11.5, width: 6.5, height: 6.5)] {
        path.append(UIBezierPath(roundedRect: rect, cornerRadius: 0.7))
      }
    path.move(to: CGPoint(x: 11.5, y: 14.75))
    path.addLine(to: CGPoint(x: 18, y: 14.75))
    path.move(to: CGPoint(x: 14.75, y: 11.5))
    path.addLine(to: CGPoint(x: 14.75, y: 18))
    path.lineWidth = 1.7
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    UIColor.label.setStroke()
    path.stroke()
  }.withRenderingMode(.alwaysTemplate)
}

extension View {
  @ViewBuilder
  func nativeInboxNavigationChrome(enabled: Bool, backIdentifier: String? = nil) -> some View {
    if enabled { inboxNavigationChrome(backIdentifier: backIdentifier) }
    else { self }
  }
  func inboxNavigationChrome(showsBottomBar: Bool = false, backIdentifier: String? = nil) -> some View {
    navigationBarTitleDisplayMode(.inline)
      .toolbar(.visible, for: .navigationBar)
      .toolbar(showsBottomBar ? .visible : .hidden, for: .bottomBar)
      .toolbarBackground(.hidden, for: .navigationBar, .bottomBar)
      .tint(NativePalette.text)
      .background(InboxNavigationBridge(backIdentifier: backIdentifier).frame(width: 0, height: 0))
  }
}

extension ToolbarContent {
  @ToolbarContentBuilder
  func inboxVerticalAction() -> some ToolbarContent {
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      axisBehavior(.verticalPreferred)
    } else {
      self
    }
    #else
    self
    #endif
  }

  /// The conversation name belongs at the center of the horizontal viewport,
  /// even when the navigation actions are in the native vertical bar.
  @ToolbarContentBuilder
  func inboxHorizontalTitle() -> some ToolbarContent {
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      axisBehavior(.horizontalOnly)
    } else {
      self
    }
    #else
    self
    #endif
  }
}

/// Adjust the native Back item without replacing navigation/gesture delegates.
/// The back action therefore follows the actual UIKit stack, including local
/// details, exchanges and recursive thread destinations absent from store.path.
private struct InboxNavigationBridge: UIViewControllerRepresentable {
  var backIdentifier: String?

  final class Controller: UIViewController {
    var backIdentifier: String?

    override func viewWillAppear(_ animated: Bool) {
      super.viewWillAppear(animated)
      configureBackItem()
    }

    override func didMove(toParent parent: UIViewController?) {
      super.didMove(toParent: parent)
      configureBackItem()
    }

    func configureBackItem() {
      guard let navigationController else { return }
      // Display mode belongs to the page being left, rather than its successor.
      // Configure all existing entries so a locally pushed destination also gets
      // the compact, circular native chevron.
      for page in navigationController.viewControllers {
        page.navigationItem.backButtonDisplayMode = .minimal
      }
      if let backIdentifier {
        var page: UIViewController = self
        while let ancestor = page.parent, ancestor !== navigationController { page = ancestor }
        if let index = navigationController.viewControllers.firstIndex(of: page), index > 0 {
          let previous = navigationController.viewControllers[index - 1].navigationItem
          let back = previous.backBarButtonItem
            ?? UIBarButtonItem(title: nil, style: .plain, target: nil, action: nil)
          back.accessibilityIdentifier = backIdentifier
          previous.backBarButtonItem = back
        }
      }
    }
  }

  func makeUIViewController(context: Context) -> Controller { Controller() }
  func updateUIViewController(_ controller: Controller, context: Context) {
    controller.backIdentifier = backIdentifier
    controller.configureBackItem()
  }
}
