import SwiftUI

/// Message cells are disposable. Presentations belong to the containing page so
/// keyboard/layout changes and cell reuse cannot dismiss an active interaction.
@MainActor @Observable final class MessageModalPresenter {
  struct Presentation: Identifiable {
    let id = UUID()
    let content: AnyView
  }
  var sheet: Presentation?
  var fullScreen: Presentation?
  private var afterDismiss: (() -> Void)?

  func dismissSheet(then action: (() -> Void)? = nil) {
    afterDismiss = action
    sheet = nil
  }
  func sheetDidDismiss() {
    let action = afterDismiss
    afterDismiss = nil
    action?()
  }
}

private struct MessageModalHost: ViewModifier {
  @Environment(AppStore.self) private var store
  @Bindable var presenter: MessageModalPresenter
  func body(content: Content) -> some View {
    content
      .sheet(item: $presenter.sheet, onDismiss: presenter.sheetDidDismiss) { modal in
        modal.content.environment(store).environment(presenter)
      }
      .fullScreenCover(item: $presenter.fullScreen) { modal in
        modal.content.environment(store).environment(presenter)
      }
  }
}

extension View {
  func messageModalHost(_ presenter: MessageModalPresenter) -> some View {
    modifier(MessageModalHost(presenter: presenter))
  }
}
