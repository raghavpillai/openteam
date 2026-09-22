import Foundation

public enum ApprovalPresentation {
  public static func siteKey(profileID: String, origin: String) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    return (try? encoder.encode([profileID, origin])).map { String(decoding: $0, as: UTF8.self) }
      ?? ""
  }
  public static func isPending(_ approval: Approval) -> Bool {
    approval.status == "pending"
      && !["running", "completed", "failed"].contains(approval.details["actionState"].string)
      && approval.details["actionError"].string.isEmpty
  }
  public static func status(_ approval: Approval) -> String {
    if ["declined", "expired", "cancelled"].contains(approval.status) {
      return approval.status == "declined" ? "Denied" : approval.status.capitalized
    }
    if !approval.details["actionError"].string.isEmpty
      || approval.details["actionState"].string == "failed"
    {
      return "Failed"
    }
    switch approval.details["actionState"].string {
    case "running": return "Running"
    case "completed": return "Completed"
    default:
      return isPending(approval)
        ? "Approval required"
        : approval.status == "accepted" ? "Approved" : approval.status.capitalized
    }
  }
}
