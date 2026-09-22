import Foundation

public enum FormValidation {
  /// An MCP endpoint is a resource URL, not the server base URL. Its query is
  /// significant and must survive validation and saving unchanged.
  public static func endpoint(_ text: String) throws -> String {
    let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let parts = URLComponents(string: value),
      ["http", "https"].contains(parts.scheme?.lowercased() ?? ""),
      let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
      parts.fragment == nil, parts.url != nil
    else { throw APIError("Enter a valid HTTP or HTTPS endpoint without embedded credentials or a fragment.") }
    return value
  }
  public static func userForm(_ form: JSON, values: [String: JSON]) throws {
    let fields = form["fields"].array
    guard Set(values.keys).isSubset(of: Set(fields.map { $0["id"].string })) else { throw APIError("The form changed. Reload it before submitting.") }
    for field in fields {
      let value = values[field["id"].string] ?? .null
      let checkbox = field["type"].string == "checkbox"
      if value != .null {
        if checkbox { guard case .bool = value else { throw APIError("Choose a value for \(field["label"].string).") } }
        else { guard case .string = value else { throw APIError("Enter a value for \(field["label"].string).") } }
      }
      if field["required"].bool, checkbox ? !value.bool : value.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw APIError("\(field["label"].string) is required.") }
      if value.string.count > 20_000 { throw APIError("\(field["label"].string) exceeds the 20,000-character limit.") }
      if field["type"].string == "select", !value.string.isEmpty, !field["options"].array.contains(where: { $0["value"] == value }) { throw APIError("Choose an available option for \(field["label"].string).") }
    }
  }
  public static func json(_ text: String, label: String, object: Bool = true) throws -> JSON {
    let result: JSON
    do { result = try JSONDecoder().decode(JSON.self, from: Data(text.utf8)) } catch {
      throw APIError("\(label) must contain valid JSON. Your changes have been kept.")
    }
    if object, case .object = result { return result }
    if !object, case .array = result { return result }
    throw APIError("\(label) must be a JSON \(object ? "object" : "list").")
  }
  public static func stringMap(_ text: String, label: String) throws -> JSON {
    let result = try json(text, label: label)
    guard
      result.object.values.allSatisfy({
        if case .string = $0 { return true }
        return false
      })
    else {
      throw APIError("Every value in \(label.lowercased()) must be text.")
    }
    return result
  }
  public static func fields(_ fields: [JSON], values: [String: JSON], savedSecrets: [String] = [])
    throws
  {
    for field in fields {
      let key = field["key"].string
      let label = field["label"].string.isEmpty ? key : field["label"].string
      let value = values[key] ?? field["default"]
      let empty =
        value == .null
        || (value.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          && {
            if case .string = value { return true }
            return false
          }())
      if empty {
        if field["required"].bool && !savedSecrets.contains(key) {
          throw APIError("Enter \(label.lowercased()).")
        }
        continue
      }
      if ["number", "integer"].contains(field["type"].string) {
        guard case .number(let number) = value, number.isFinite,
          field["type"].string != "integer" || number.rounded() == number
        else {
          throw APIError(
            "\(label) must be \(field["type"].string == "integer" ? "a whole number" : "a number")."
          )
        }
      }
      if !field["enum"].array.isEmpty, !field["enum"].array.contains(value) {
        throw APIError("Choose one of the available values for \(label.lowercased()).")
      }
      if value.string.count > 20_000 {
        throw APIError("\(label) is too long. Use no more than 20,000 characters.")
      }
    }
  }
}
