import SafariServices
import SwiftUI
import UIKit

/// Opens chat links in a Safari sheet over the app, so reading a link does not
/// leave the conversation. Other schemes, such as mailto, go to their own app.
@MainActor enum InAppBrowser {
  static let schemes: Set<String> = ["https", "http", "mailto"]

  /// Returns false for schemes chat links must not open.
  @discardableResult static func open(_ url: URL) -> Bool {
    let scheme = url.scheme?.lowercased() ?? ""
    guard schemes.contains(scheme) else { return false }
    guard scheme == "https" || scheme == "http", let presenter = topViewController() else {
      UIApplication.shared.open(url)
      return true
    }
    let safari = SFSafariViewController(url: url)
    safari.dismissButtonStyle = .done
    // Phones get the whole screen; wider windows a sheet over the conversation.
    // Both keep the chat in place underneath: a plain full-screen presentation
    // ends the chat's appearance, which closes the conversation.
    safari.modalPresentationStyle =
      presenter.traitCollection.horizontalSizeClass == .compact ? .overFullScreen : .pageSheet
    presenter.present(safari, animated: true)
    return true
  }

  static func share(_ url: URL) {
    guard let presenter = topViewController() else { return }
    let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
    if let popover = share.popoverPresentationController {
      popover.sourceView = presenter.view
      popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY - 80, width: 1, height: 1)
      popover.permittedArrowDirections = .down
    }
    presenter.present(share, animated: true)
  }

  /// SwiftUI `Text` links resolve through this action.
  static var action: OpenURLAction {
    OpenURLAction { url in open(url) ? .handled : .discarded }
  }

  private static func topViewController() -> UIViewController? {
    let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState == .foregroundActive }
      .flatMap(\.windows).first(where: \.isKeyWindow)
    var top = window?.rootViewController
    while let presented = top?.presentedViewController, !presented.isBeingDismissed {
      top = presented
    }
    return top
  }
}
