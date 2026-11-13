import SwiftUI
import UIKit

/// Native spreadsheet preview for CSV and TSV files. It follows the desktop preview, which
/// itself copies the reference app: a value bar for the selected cell, a header row that
/// stays at the top, row numbers that stay at the leading edge, hairline cell borders,
/// right-aligned numbers, a tinted selection and a green outline on the active cell.
struct SpreadsheetPreview: View {
  let url: URL
  var onLoad: (SpreadsheetTable) -> Void = { _ in }

  @State private var table: SpreadsheetTable?
  @State private var failed = false
  @State private var showLoading = false
  @State private var anchor: Cell?
  @State private var active: Cell?
  @State private var expanded = false
  @State private var copied = false
  @State private var offset: CGPoint = .zero

  struct Cell: Equatable { var row: Int; var column: Int }

  private static let rowHeight: CGFloat = 28
  private static let numberWidth: CGFloat = 40
  private static let inset: CGFloat = 12
  private static let border = NativePalette.color("E7E7E7", "2B2B2B")
  private static let cellText = NativePalette.color("5C5C5C", "A8A8A8")
  private static let activeOutline = Color(red: 0x54 / 255, green: 0xB3 / 255, blue: 0x9D / 255)
  private static let selectionFill = NativePalette.link.opacity(0.14)
  private static let font = UIFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)
  /// Columns fit their content rather than truncating dates and short headers.
  private static func measure(_ text: String) -> CGFloat {
    (text as NSString).size(withAttributes: [.font: font]).width + 2
  }

  var body: some View {
    Group {
      if let table, !table.rows.isEmpty {
        VStack(spacing: 0) {
          valueBar(table)
          Rectangle().fill(Self.border).frame(height: 1)
          grid(table)
        }
      } else if failed || table?.rows.isEmpty == true {
        status(symbol: "tablecells", text: failed ? "This file couldn't be read." : "This spreadsheet is empty.")
      } else if showLoading {
        VStack(spacing: 10) {
          ProgressView()
          Text("Loading…").font(.system(size: 13)).foregroundStyle(NativePalette.muted)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        Color.clear
      }
    }
    .task(id: url) { await load() }
  }

  // MARK: Loading

  private func load() async {
    let url = url
    let spinner = Task { try? await Task.sleep(for: .milliseconds(180)); showLoading = true }
    let parsed = await Task.detached(priority: .userInitiated) { () -> SpreadsheetTable? in
      guard let data = try? Data(contentsOf: url) else { return nil }
      return SpreadsheetTable.parse(data, fileName: url.lastPathComponent)
    }.value
    spinner.cancel()
    if let parsed {
      table = parsed
      onLoad(parsed)
    } else {
      failed = true
    }
  }

  private func status(symbol: String, text: String) -> some View {
    VStack(spacing: 12) {
      Image(systemName: symbol).font(.system(size: 24)).foregroundStyle(NativePalette.faint)
      Text(text).font(.system(size: 15)).foregroundStyle(NativePalette.muted)
    }.frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityIdentifier("spreadsheet-status")
  }

  // MARK: Value bar

  private func valueBar(_ table: SpreadsheetTable) -> some View {
    HStack(alignment: expanded ? .top : .center, spacing: 8) {
      if let active {
        Text(rangeLabel(active))
          .font(.system(size: 11, weight: .medium)).monospacedDigit()
          .foregroundStyle(Self.cellText)
          .padding(.horizontal, 6).padding(.vertical, 1)
          .background(NativePalette.text.opacity(0.07), in: RoundedRectangle(cornerRadius: 4))
          .accessibilityIdentifier("spreadsheet-address")
        ScrollView(.vertical) {
          Text(value(table, active))
            .font(.system(size: 13)).foregroundStyle(NativePalette.text)
            .lineLimit(expanded ? nil : 1).truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
            .accessibilityIdentifier("spreadsheet-value")
        }
        .scrollDisabled(!expanded).frame(maxHeight: expanded ? 180 : 20).fixedSize(horizontal: false, vertical: !expanded)
        barButton(expanded ? "chevron.up" : "chevron.down", expanded ? "Collapse cell value" : "Expand cell value") {
          withAnimation(.snappy(duration: 0.22)) { expanded.toggle() }
        }
        barButton(copied ? "checkmark" : "doc.on.doc", "Copy selected cells") {
          UIPasteboard.general.string = selectedText(table)
          NativeHaptics.play(.light, source: "spreadsheet.copy")
          copied = true
          Task { try? await Task.sleep(for: .seconds(1.2)); copied = false }
        }
      } else {
        Text("Tap a cell to see its value. Tap a row number to select the row.")
          .font(.system(size: 13)).foregroundStyle(NativePalette.muted)
          .lineLimit(1).minimumScaleFactor(0.85)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(.horizontal, 12).padding(.vertical, 5).frame(minHeight: 37)
  }

  private func barButton(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: 13, weight: .medium))
        .foregroundStyle(NativePalette.text.opacity(0.75))
        .frame(width: 28, height: 28)
        .contentTransition(.symbolEffect(.replace))
        .contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityLabel(label)
  }

  // MARK: Grid

  private func grid(_ table: SpreadsheetTable) -> some View {
    let widths = table.columnWidths(measure: Self.measure)
    let contentWidth = widths.reduce(0, +)
    let h = Self.rowHeight, inset = Self.inset, numbers = Self.numberWidth
    return GeometryReader { proxy in
      ScrollView([.horizontal, .vertical]) {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(1..<table.rows.count, id: \.self) { row in
            rowCells(table, row: row, widths: widths)
          }
        }
        .frame(width: contentWidth, alignment: .leading)
        .padding(.top, inset + h).padding(.leading, inset + numbers)
        .padding(.trailing, inset).padding(.bottom, inset + proxy.safeAreaInsets.bottom)
      }
      .scrollIndicators(.visible)
      .onScrollGeometryChange(for: CGPoint.self) { $0.contentOffset } action: { _, new in offset = new }
      .overlay(alignment: .topLeading) {
        // Header row: follows horizontal scrolling, sticks to the top vertically.
        HStack(spacing: 0) {
          ForEach(0..<table.columnCount, id: \.self) { column in
            cell(table, row: 0, column: column, width: widths[column], header: true)
          }
        }
        .overlay(alignment: .top) { Rectangle().fill(Self.border).frame(height: 1) }
        .background(NativePalette.background)
        .offset(x: inset + numbers - offset.x, y: max(0, inset - offset.y))
        .allowsHitTesting(true)
      }
      .overlay(alignment: .topLeading) {
        rowNumbers(table, viewport: proxy.size.height)
          .offset(x: max(0, inset - offset.x))
      }
      .overlay(alignment: .topLeading) {
        // The corner keeps the header row's number above the sticky column.
        numberCell(0, table: table)
          .overlay(alignment: .top) { Rectangle().fill(Self.border).frame(height: 1) }
          .offset(x: max(0, inset - offset.x), y: max(0, inset - offset.y))
      }
      .clipped()
    }
    .background(NativePalette.background)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("spreadsheet-grid")
  }

  private func rowCells(_ table: SpreadsheetTable, row: Int, widths: [CGFloat]) -> some View {
    HStack(spacing: 0) {
      ForEach(0..<table.columnCount, id: \.self) { column in
        cell(table, row: row, column: column, width: widths[column], header: false)
      }
    }
  }

  private func cell(_ table: SpreadsheetTable, row: Int, column: Int, width: CGFloat, header: Bool)
    -> some View
  {
    let text = table.rows[row][column]
    let numeric = !header && SpreadsheetTable.isNumeric(text)
    let current = active == Cell(row: row, column: column)
    let address = SpreadsheetTable.address(row: row, column: column)
    return Text(text)
      .font(.system(size: 13))
      .monospacedDigit()
      .foregroundStyle(header ? NativePalette.text : Self.cellText)
      .lineLimit(1).truncationMode(.tail)
      .padding(.horizontal, 8)
      .frame(width: width, height: Self.rowHeight, alignment: numeric ? .trailing : .leading)
      .background(isSelected(row, column) ? Self.selectionFill : .clear)
      .overlay(alignment: .trailing) { Rectangle().fill(Self.border).frame(width: 1) }
      .overlay(alignment: .bottom) { Rectangle().fill(Self.border).frame(height: 1) }
      .overlay { if current { Rectangle().inset(by: 0.75).stroke(Self.activeOutline, lineWidth: 1.5) } }
      .contentShape(Rectangle())
      .onTapGesture { select(Cell(row: row, column: column), table: table) }
      .accessibilityElement()
      .accessibilityLabel(text.isEmpty ? "\(address), empty" : "\(address), \(text)")
      .accessibilityAddTraits(isSelected(row, column) ? [.isButton, .isSelected] : .isButton)
      .accessibilityIdentifier("spreadsheet-cell-\(row)-\(column)")
  }

  /// Only the visible numbers are drawn, so long files stay cheap to scroll.
  private func rowNumbers(_ table: SpreadsheetTable, viewport: CGFloat) -> some View {
    let h = Self.rowHeight
    let top = Self.inset + h - offset.y
    let first = max(1, Int(floor((0 - top) / h)) + 1)
    let last = min(table.rows.count - 1, Int(ceil((viewport - top) / h)) + 1)
    return ZStack(alignment: .topLeading) {
      if first <= last {
        ForEach(first...last, id: \.self) { row in
          numberCell(row, table: table).offset(y: top + CGFloat(row - 1) * h)
        }
      }
    }
    .frame(width: Self.numberWidth, height: viewport, alignment: .topLeading)
  }

  private func numberCell(_ row: Int, table: SpreadsheetTable) -> some View {
    Text(String(row + 1))
      .font(.system(size: 13)).monospacedDigit()
      .foregroundStyle(Self.cellText)
      .padding(.horizontal, 8)
      .frame(width: Self.numberWidth, height: Self.rowHeight, alignment: .trailing)
      .background(isRowSelected(row, table) ? Self.selectionFill : .clear)
      .background(NativePalette.background)
      .overlay(alignment: .leading) { Rectangle().fill(Self.border).frame(width: 1) }
      .overlay(alignment: .trailing) { Rectangle().fill(Self.border).frame(width: 1) }
      .overlay(alignment: .bottom) { Rectangle().fill(Self.border).frame(height: 1) }
      .contentShape(Rectangle())
      .onTapGesture {
        anchor = Cell(row: row, column: 0)
        active = Cell(row: row, column: max(0, table.columnCount - 1))
        NativeHaptics.play(.selection, source: "spreadsheet.select")
      }
      .accessibilityElement()
      .accessibilityLabel("Row \(row + 1)")
      .accessibilityHint("Selects the row")
      .accessibilityAddTraits(.isButton)
      .accessibilityIdentifier("spreadsheet-row-\(row)")
  }

  // MARK: Selection

  private func select(_ cell: Cell, table: SpreadsheetTable) {
    anchor = cell
    active = cell
    NativeHaptics.play(.selection, source: "spreadsheet.select")
  }

  private var bounds: (r0: Int, r1: Int, c0: Int, c1: Int)? {
    guard let anchor, let active else { return nil }
    return (
      min(anchor.row, active.row), max(anchor.row, active.row),
      min(anchor.column, active.column), max(anchor.column, active.column)
    )
  }

  private func isSelected(_ row: Int, _ column: Int) -> Bool {
    guard let b = bounds else { return false }
    return row >= b.r0 && row <= b.r1 && column >= b.c0 && column <= b.c1
  }

  private func isRowSelected(_ row: Int, _ table: SpreadsheetTable) -> Bool {
    guard let b = bounds else { return false }
    return row >= b.r0 && row <= b.r1 && b.c0 == 0 && b.c1 == table.columnCount - 1
  }

  private func rangeLabel(_ active: Cell) -> String {
    let end = SpreadsheetTable.address(row: active.row, column: active.column)
    guard let anchor, anchor != active else { return end }
    return SpreadsheetTable.address(row: anchor.row, column: anchor.column) + ":" + end
  }

  private func value(_ table: SpreadsheetTable, _ active: Cell) -> String {
    guard let b = bounds, b.r0 != b.r1 || b.c0 != b.c1 else { return table.rows[active.row][active.column] }
    return table.rows[b.r0].dropFirst(b.c0).prefix(b.c1 - b.c0 + 1).filter { !$0.isEmpty }.joined(separator: " · ")
  }

  private func selectedText(_ table: SpreadsheetTable) -> String {
    guard let b = bounds else { return "" }
    return (b.r0...b.r1).map { row in
      (b.c0...b.c1).map { table.rows[row][$0] }.joined(separator: "\t")
    }.joined(separator: "\n")
  }
}
