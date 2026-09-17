import UIKit

/// Read the actual editing control once when recording starts. Keeping a second,
/// two-way SwiftUI selection binding can race a persisted composer text update.
@MainActor enum NativeTextSelection {
  static func range(matching text: String) -> Range<String.Index>? {
    func editingInput(in view: UIView) -> (any UITextInput)? {
      if view.isFirstResponder {
        if let input = view as? UITextView, input.text == text { return input }
        if let input = view as? UITextField, input.text == text { return input }
      }
      for child in view.subviews {
        if let input = editingInput(in: child) { return input }
      }
      return nil
    }
    for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
      guard scene.activationState == .foregroundActive else { continue }
      for window in scene.windows where !window.isHidden {
        guard let input = editingInput(in: window), let selected = input.selectedTextRange else {
          continue
        }
        let start = input.offset(from: input.beginningOfDocument, to: selected.start)
        let end = input.offset(from: input.beginningOfDocument, to: selected.end)
        guard start >= 0, end >= start else { return nil }
        return Range(NSRange(location: start, length: end - start), in: text)
      }
    }
    return nil
  }
}
