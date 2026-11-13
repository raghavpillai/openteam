import XCTest

@testable import OpenTeamCore

final class SpreadsheetTableTests: XCTestCase {
  private func parse(_ text: String, _ name: String = "Data.csv", maxRows: Int = 5_000)
    -> SpreadsheetTable
  {
    SpreadsheetTable.parse(Data(text.utf8), fileName: name, maxRows: maxRows)
  }

  func testHeaderAndRowsWithTrailingNewline() {
    let table = parse("Date,Merchant,Amount\n2026-11-01,Corner Coffee,5.5\n2026-11-02,Fresh Market,9.25\n")
    XCTAssertEqual(table.rows.first, ["Date", "Merchant", "Amount"])
    XCTAssertEqual(table.rows.count, 3)
    XCTAssertEqual(table.totalRows, 2)
    XCTAssertEqual(table.columnCount, 3)
  }

  func testQuotedFieldsKeepDelimitersNewlinesAndEscapedQuotes() {
    let table = parse("Name,Note\n\"Smith, Jane\",\"Said \"\"hi\"\"\nthen left\"\r\nBo,ok\r\n")
    XCTAssertEqual(table.rows[1], ["Smith, Jane", "Said \"hi\"\nthen left"])
    XCTAssertEqual(table.rows[2], ["Bo", "ok"])
    XCTAssertEqual(table.totalRows, 2)
  }

  func testUnicodeAndByteOrderMark() {
    let table = parse("\u{FEFF}Name,City\nRenée,Zürich\n山田,東京 🎉\n")
    XCTAssertEqual(table.rows[0], ["Name", "City"])
    XCTAssertEqual(table.rows[2], ["山田", "東京 🎉"])
  }

  func testLatin1FallbackForNonUTF8Files() {
    var bytes = Array("Name\n".utf8)
    bytes += [0x52, 0x65, 0x6E, 0xE9, 0x65, 0x0A]  // "Renée" in Windows-1252
    let table = SpreadsheetTable.parse(Data(bytes), fileName: "Legacy.csv")
    XCTAssertEqual(table.rows[1], ["Renée"])
  }

  func testDetectsSemicolonsAndTabs() {
    XCTAssertEqual(parse("a;b;c\n1;2;3\n").rows[1], ["1", "2", "3"])
    XCTAssertEqual(parse("a\tb\n1\t2\n").rows[1], ["1", "2"])
    XCTAssertEqual(parse("a,b\n1,2\n", "Data.tsv").rows[1], ["1,2"], "TSV files always split on tabs")
    XCTAssertEqual(parse("\"x;y\",b\n1,2\n").rows[0], ["x;y", "b"], "quoted delimiters do not count")
  }

  func testRaggedRowsArePaddedToTheWidestRow() {
    let table = parse("a,b,c\n1\n1,2,3,4\n")
    XCTAssertEqual(table.columnCount, 4)
    XCTAssertEqual(table.rows[1], ["1", "", "", ""])
  }

  func testLargeFilesKeepTheTotalButLimitPreviewRows() {
    let body = (1...50).map { "row \($0),\($0)" }.joined(separator: "\n")
    let table = parse("Name,Value\n" + body, maxRows: 10)
    XCTAssertEqual(table.rows.count, 11, "header plus the first ten rows")
    XCTAssertEqual(table.totalRows, 50)
  }

  func testEmptyFile() {
    let table = parse("")
    XCTAssertTrue(table.rows.isEmpty)
    XCTAssertEqual(table.totalRows, 0)
  }

  func testAddressesWidthsAndNumbers() {
    XCTAssertEqual(SpreadsheetTable.address(row: 2, column: 1), "B3")
    XCTAssertEqual(SpreadsheetTable.address(row: 0, column: 26), "AA1")
    XCTAssertTrue(SpreadsheetTable.isNumeric("-12.50"))
    XCTAssertFalse(SpreadsheetTable.isNumeric("12a"))
    let table = parse("A,Merchant\n1,\(String(repeating: "x", count: 60))\n")
    XCTAssertEqual(table.columnWidths(), [62, 280])
    XCTAssertEqual(table.columnWidths(measure: { CGFloat($0.count) * 10 }), [62, 280])
    XCTAssertEqual(parse("Date\n2026-11-01\n").columnWidths(measure: { CGFloat($0.count) * 8 }), [96])
  }

  func testPreviewableTypes() {
    XCTAssertTrue(SpreadsheetTable.canPreview(fileName: "Transactions.csv", mimeType: ""))
    XCTAssertTrue(SpreadsheetTable.canPreview(fileName: "export", mimeType: "text/csv; charset=utf-8"))
    XCTAssertTrue(SpreadsheetTable.canPreview(fileName: "Data.TSV", mimeType: ""))
    XCTAssertFalse(SpreadsheetTable.canPreview(fileName: "Budget.xlsx", mimeType: ""))
  }
}
