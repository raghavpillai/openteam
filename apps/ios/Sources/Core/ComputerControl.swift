import Foundation

public enum ComputerControl {
  public static func owns(_ status: JSON, viewerID: String) -> Bool {
    status["humanTakeover"].bool && !status["controlPending"].bool && status["controlSession"]["id"].string == viewerID
  }
  public static func request(active: Bool, viewerID: String, generation: Int, force: Bool = false) -> JSON {
    .object(["active": .bool(active), "controlId": .string(viewerID),
      "generation": .number(Double(generation)), "force": .bool(force)])
  }
}
