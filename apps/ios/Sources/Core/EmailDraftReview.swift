import Foundation

public enum EmailDraftReview {
  public static func validRecipients(to: String, cc: String) -> Bool {
    func addresses(_ text: String) -> [String] {
      text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
    let recipients = addresses(to)
    let pattern = #"^[^\s<>@,;:\x00-\x1f\x7f]+@[^\s<>@,;:\x00-\x1f\x7f]+\.[^\s<>@,;:\x00-\x1f\x7f]+$"#
    return !recipients.isEmpty && recipients.count <= 100 && addresses(cc).count <= 100 && (recipients + addresses(cc)).allSatisfy {
      $0.utf16.count <= 320 && $0.range(of: pattern, options: .regularExpression) != nil
    }
  }
}
