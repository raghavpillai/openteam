import SwiftUI
import UIKit

/// Present over the current sheet, rather than asking the root SwiftUI view to replace its sheet.
struct NativeErrorPresenter: UIViewControllerRepresentable {
  @Binding var message: String?
  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeUIViewController(context: Context) -> UIViewController { UIViewController() }
  func updateUIViewController(_ controller: UIViewController, context: Context) {
    context.coordinator.update(message: $message, controller: controller)
  }
  static func dismantleUIViewController(_ controller: UIViewController, coordinator: Coordinator) {
    coordinator.task?.cancel()
    coordinator.alert?.dismiss(animated: false)
  }
  @MainActor final class Coordinator {
    var task: Task<Void, Never>?
    weak var alert: UIAlertController?
    private var current: String?
    func update(message: Binding<String?>, controller: UIViewController) {
      guard message.wrappedValue != current else { return }
      current = message.wrappedValue
      task?.cancel()
      guard let text = current else { alert?.dismiss(animated: true); return }
      if let alert { alert.message = text; return }
      task = Task { @MainActor [weak self, weak controller] in
        while !Task.isCancelled, message.wrappedValue != nil {
          guard let self, let controller else { return }
          if let root = controller.view.window?.rootViewController {
            var top = root
            while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
            if !(top is UIAlertController), !top.isBeingPresented, !top.isBeingDismissed {
              let alert = UIAlertController(title: "OpenTeam", message: message.wrappedValue, preferredStyle: .alert)
              alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in message.wrappedValue = nil })
              self.alert = alert
              top.present(alert, animated: true)
              return
            }
          }
          do { try await Task.sleep(for: .milliseconds(150)) } catch { return }
        }
      }
    }
  }
}
