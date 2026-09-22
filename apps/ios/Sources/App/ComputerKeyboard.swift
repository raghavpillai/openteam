import SwiftUI
import UIKit

/// A native keyboard that forwards committed input through the same ordered queue as pointer events.
struct ComputerKeyboard: UIViewRepresentable {
  var active: Bool
  var send: ([String: JSON]) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(send: send) }
  func makeUIView(context: Context) -> UITextField {
    let field = UITextField()
    field.delegate = context.coordinator
    field.addTarget(
      context.coordinator, action: #selector(Coordinator.edited(_:)), for: .editingChanged)
    field.autocorrectionType = .no
    field.autocapitalizationType = .none
    field.spellCheckingType = .no
    field.smartQuotesType = .no
    field.smartDashesType = .no
    field.keyboardAppearance = .dark
    field.text = " "  // Keep a deletion target so the system delivers backspace.
    return field
  }
  func updateUIView(_ field: UITextField, context: Context) {
    context.coordinator.send = send
    context.coordinator.active = active
    if active, !field.isFirstResponder {
      field.becomeFirstResponder()
    } else if !active, field.isFirstResponder {
      field.resignFirstResponder()
    }
  }
  final class Coordinator: NSObject, UITextFieldDelegate {
    var send: ([String: JSON]) -> Void
    var active = false
    init(send: @escaping ([String: JSON]) -> Void) { self.send = send }
    func textField(
      _ textField: UITextField, shouldChangeCharactersIn range: NSRange,
      replacementString string: String
    ) -> Bool {
      guard active else { return false }
      if string.isEmpty, (textField.text ?? " ").count <= 1, textField.markedTextRange == nil {
        send(["action": .string("key"), "keys": .array([.string("BackSpace")])])
        return false
      }
      return true
    }
    @objc func edited(_ field: UITextField) {
      guard active, field.markedTextRange == nil else { return }
      let value = field.text ?? ""
      let committed = value.hasPrefix(" ") ? String(value.dropFirst()) : value
      if !committed.isEmpty { send(["action": .string("type"), "text": .string(committed)]) }
      field.text = " "
    }
    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
      if active { send(["action": .string("key"), "keys": .array([.string("Return")])]) }
      return false
    }
  }
}
