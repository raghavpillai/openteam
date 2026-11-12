/// Requests the adjacent server page before a reader reaches the loaded edge.
/// A failed cursor is attempted once per visit to the edge; leaving and returning
/// retries it. Changing the cursor after success permits the next page.
public struct HistoryPageTrigger {
  public enum Direction { case earlier, later }
  private var requestedEarlier: String?
  private var requestedLater: String?
  public init() {}

  public mutating func update(firstVisible: Int, lastVisible: Int, count: Int,
    direction: Double, earlier: String?, later: String?) -> Direction? {
    guard count > 0 else { return nil }
    let nearEarlier = firstVisible <= 6
    let nearLater = lastVisible >= count - 7
    if !nearEarlier { requestedEarlier = nil }
    if !nearLater { requestedLater = nil }
    if direction > 0, nearEarlier, let earlier, earlier != requestedEarlier {
      requestedEarlier = earlier
      return .earlier
    }
    if direction < 0, nearLater, let later, later != requestedLater {
      requestedLater = later
      return .later
    }
    return nil
  }
}
