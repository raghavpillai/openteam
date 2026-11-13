import Foundation

/// A delimited text file (CSV or TSV) read into rows for the native spreadsheet preview.
/// Mirrors the desktop preview (apps/desktop/.../document-preview/spreadsheet-view.tsx):
/// the first row is the header, column widths follow their content, and very large files
/// show their first rows while still reporting the full row count.
public struct SpreadsheetTable: Equatable, Sendable {
  public var rows: [[String]]
  /// Data rows in the whole file, excluding the header, even past the preview limit.
  public var totalRows: Int
  public var columnCount: Int

  public static let maxPreviewRows = 5_000
  public static let maxPreviewColumns = 64

  public static func canPreview(fileName: String, mimeType: String) -> Bool {
    let ext = (fileName as NSString).pathExtension.lowercased()
    if ["csv", "tsv", "tab"].contains(ext) { return true }
    let mime = mimeType.lowercased().split(separator: ";").first.map(String.init) ?? ""
    return ["text/csv", "application/csv", "text/tab-separated-values"].contains(mime)
  }

  public static func parse(
    _ data: Data, fileName: String = "", maxRows: Int = maxPreviewRows,
    maxColumns: Int = maxPreviewColumns
  ) -> SpreadsheetTable {
    let text = decode(data)
    let ext = (fileName as NSString).pathExtension.lowercased()
    let delimiter: Character = ext == "tsv" || ext == "tab" ? "\t" : detectDelimiter(text)
    var rows: [[String]] = []
    var row: [String] = []
    var field = ""
    var quoted = false
    var fieldStarted = false
    var total = 0
    var columns = 0
    func endField() {
      if row.count < maxColumns { row.append(field) }
      field = ""
      fieldStarted = false
    }
    func endRow() {
      endField()
      // A trailing newline or blank line is not a row.
      if row.count == 1, row[0].isEmpty { row = []; return }
      total += 1
      if rows.count < maxRows + 1 {
        columns = max(columns, row.count)
        rows.append(row)
      }
      row = []
    }
    var iterator = text.makeIterator()
    var pending: Character? = nil
    while let character = pending ?? iterator.next() {
      pending = nil
      if quoted {
        if character == "\"" {
          if let next = iterator.next() {
            if next == "\"" { field.append("\"") } else { quoted = false; pending = next }
          } else {
            quoted = false
          }
        } else {
          field.append(character)
        }
        continue
      }
      switch character {
      case "\"" where !fieldStarted && field.isEmpty:
        quoted = true
        fieldStarted = true
      case delimiter:
        endField()
      case "\r\n", "\n", "\r":
        endRow()
      default:
        field.append(character)
        fieldStarted = true
      }
    }
    if !field.isEmpty || !row.isEmpty || fieldStarted { endRow() }
    let normalized = rows.map { $0 + Array(repeating: "", count: max(0, columns - $0.count)) }
    return SpreadsheetTable(rows: normalized, totalRows: max(0, total - 1), columnCount: columns)
  }

  /// Column widths in points: the widest of the first 40 values plus the cell's 8 pt side
  /// padding, kept between 62 and 280 pt like the desktop preview. `measure` returns a value's
  /// rendered width; by default it estimates about 7 pt per character, as desktop does.
  public func columnWidths(measure: (String) -> CGFloat = { CGFloat(min(38, $0.count)) * 7 + 2 })
    -> [CGFloat]
  {
    (0..<columnCount).map { column in
      let widest = rows.prefix(40).map { measure($0[column]) }.max() ?? 0
      return min(280, max(62, (widest + 16).rounded(.up)))
    }
  }

  /// Spreadsheet address such as "B3" for a zero-based row and column.
  public static func address(row: Int, column: Int) -> String {
    var letters = ""
    var n = column + 1
    while n > 0 {
      letters = String(UnicodeScalar(UInt8(65 + (n - 1) % 26))) + letters
      n = (n - 1) / 26
    }
    return letters + String(row + 1)
  }

  public static func isNumeric(_ value: String) -> Bool {
    value.range(of: #"^-?\d+(\.\d+)?$"#, options: .regularExpression) != nil
  }

  private static func decode(_ data: Data) -> String {
    if data.starts(with: [0xFF, 0xFE]) || data.starts(with: [0xFE, 0xFF]),
      let text = String(data: data, encoding: .utf16)
    {
      return text
    }
    if let text = String(data: data, encoding: .utf8) {
      return text.hasPrefix("\u{FEFF}") ? String(text.dropFirst()) : text
    }
    return String(data: data, encoding: .windowsCP1252) ?? String(decoding: data, as: UTF8.self)
  }

  /// Comma, semicolon or tab: whichever appears most outside quotes on the first line.
  private static func detectDelimiter(_ text: String) -> Character {
    var counts: [Character: Int] = [",": 0, ";": 0, "\t": 0]
    var quoted = false
    for character in text.prefix(4_096) {
      if character == "\"" { quoted.toggle(); continue }
      if quoted { continue }
      if character == "\n" || character == "\r\n" || character == "\r" { break }
      if counts[character] != nil { counts[character]! += 1 }
    }
    // Comma wins ties; another delimiter must be strictly more common.
    return [";", "\t"].reduce(Character(",")) { counts[$1]! > counts[$0]! ? $1 : $0 }
  }
}
