import { ChevronDown, ChevronUp, Copy } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualWindow } from "../../../hooks/use-virtual-window";
import { AttachmentStageTools } from "../attachment-stage";

type Cell = { row: number; col: number };
const address = ({ row, col }: Cell) => {
  let letters = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26))
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return `${letters}${row + 1}`;
};

export function SpreadsheetPreview({ source }: { source: HTMLElement }) {
  const sheets = useMemo(() => {
    const sections = [...source.querySelectorAll<HTMLElement>("[data-sheet-name]")];
    const elements = sections.length ? sections : [source];
    return elements.map((section, index) => ({
      name: section.dataset.sheetName ?? `Sheet ${index + 1}`,
      rows: [...section.querySelectorAll("tr")].map((row) =>
        [...row.querySelectorAll("td,th")].map((cell) => cell.textContent ?? "")
      ),
      total: Number(section.dataset.sheetRows ?? 0),
    }));
  }, [source]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const sheet = sheets[sheetIndex] ?? sheets[0]!;
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [active, setActive] = useState<Cell | null>(null);
  const [expanded, setExpanded] = useState(false);
  const dragging = useRef(false);
  const gridRef = useRef<HTMLTableElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cols = Math.max(1, ...sheet.rows.map((row) => row.length));
  const widths = useMemo(
    () =>
      Array.from({ length: cols }, (_, col) =>
        Math.min(
          280,
          Math.max(
            62,
            ...sheet.rows.slice(0, 40).map((row) => Math.min(38, (row[col] ?? "").length) * 7 + 18)
          )
        )
      ),
    [sheet, cols]
  );
  const template = `40px ${widths.map((width) => `${width}px`).join(" ")}`;
  const width = widths.reduce((sum, width) => sum + width, 40);
  const rowKey = useCallback((index: number) => `${sheet.name}:${index}`, [sheet.name]);
  const rowHeight = useCallback(() => 28, []);
  const { totalSize, virtualItems } = useVirtualWindow({
    count: Math.max(0, sheet.rows.length - 1),
    estimateSize: rowHeight,
    getKey: rowKey,
    scrollRef,
    initialViewportSize: 800,
    overscan: 280,
    maxItems: 90,
  });
  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);
  const bounds =
    anchor && active
      ? {
          r0: Math.min(anchor.row, active.row),
          r1: Math.max(anchor.row, active.row),
          c0: Math.min(anchor.col, active.col),
          c1: Math.max(anchor.col, active.col),
        }
      : null;
  const selectedText = () =>
    bounds
      ? sheet.rows
          .slice(bounds.r0, bounds.r1 + 1)
          .map((row) =>
            Array.from(
              { length: bounds.c1 - bounds.c0 + 1 },
              (_, col) => row[bounds.c0 + col] ?? ""
            ).join("\t")
          )
          .join("\n")
      : "";
  const select = (cell: Cell, extend = false) => {
    if (!extend || !anchor) setAnchor(cell);
    setActive(cell);
    gridRef.current?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setAnchor({ row: 0, col: 0 });
      setActive({ row: sheet.rows.length - 1, col: cols - 1 });
      return;
    }
    const start = active ?? { row: 1, col: 0 };
    const next = { ...start };
    if (event.key === "ArrowUp") next.row--;
    else if (event.key === "ArrowDown") next.row++;
    else if (event.key === "ArrowLeft") next.col--;
    else if (event.key === "ArrowRight" || event.key === "Tab")
      next.col += event.shiftKey && event.key === "Tab" ? -1 : 1;
    else if (event.key === "Home") next.col = 0;
    else if (event.key === "End") next.col = cols - 1;
    else return;
    // Tab remains available for leaving the grid and closing the modal.
    if (event.key === "Tab") return;
    event.preventDefault();
    next.row = Math.max(0, Math.min(sheet.rows.length - 1, next.row));
    next.col = Math.max(0, Math.min(cols - 1, next.col));
    select(next, event.shiftKey);
    const scroll = scrollRef.current;
    if (scroll) {
      const top = next.row * 28;
      if (top < scroll.scrollTop + 28) scroll.scrollTop = Math.max(0, top - 28);
      else if (top + 28 > scroll.scrollTop + scroll.clientHeight)
        scroll.scrollTop = top + 28 - scroll.clientHeight;
      const left = widths.slice(0, next.col).reduce((sum, width) => sum + width, 40);
      if (left < scroll.scrollLeft + 40) scroll.scrollLeft = Math.max(0, left - 40);
      else if (left + widths[next.col]! > scroll.scrollLeft + scroll.clientWidth)
        scroll.scrollLeft = left + widths[next.col]! - scroll.clientWidth;
    }
  };
  const cell = (row: number, col: number, header = false) => {
    const value = sheet.rows[row]?.[col] ?? "";
    const selected =
      bounds && row >= bounds.r0 && row <= bounds.r1 && col >= bounds.c0 && col <= bounds.c1;
    const current = active?.row === row && active.col === col;
    const props = {
      "aria-colindex": col + 2,
      "aria-selected": Boolean(selected),
      "data-row": row,
      "data-col": col,
      "data-active": current || undefined,
      title: value,
      onPointerDown: (event: React.PointerEvent) => {
        event.preventDefault();
        dragging.current = true;
        select({ row, col }, event.shiftKey);
      },
      onPointerEnter: () => {
        if (dragging.current) setActive({ row, col });
      },
    };
    return header ? (
      <th key={col} role="columnheader" {...props}>
        {value}
      </th>
    ) : (
      <td
        key={col}
        role="gridcell"
        {...props}
        data-numeric={/^-?\d+(\.\d+)?$/.test(value) || undefined}
      >
        {value}
      </td>
    );
  };
  const rowStyle = { gridTemplateColumns: template, width } satisfies CSSProperties;
  return (
    <div className="spreadsheet-preview">
      <AttachmentStageTools>
        <span className="preview-meta">
          {sheet.total || Math.max(0, sheet.rows.length - 1)} rows
        </span>
        {sheets.length > 1 && (
          <div aria-label="Workbook sheets" className="preview-segmented" role="tablist">
            {sheets.map((item, index) => (
              <button
                aria-selected={index === sheetIndex}
                key={item.name}
                onClick={() => {
                  setSheetIndex(index);
                  setAnchor(null);
                  setActive(null);
                  if (scrollRef.current) scrollRef.current.scrollTop = 0;
                }}
                role="tab"
                type="button"
              >
                {item.name}
              </button>
            ))}
          </div>
        )}
      </AttachmentStageTools>
      <div className="spreadsheet-value-bar" data-expanded={expanded || undefined}>
        <div>
          {active ? (
            <>
              <span className="spreadsheet-address">
                {anchor && address(anchor) !== address(active)
                  ? `${address(anchor)}:${address(active)}`
                  : address(active)}
              </span>
              <span className="spreadsheet-value">{sheet.rows[active.row]?.[active.col]}</span>
            </>
          ) : (
            <span className="preview-meta">
              Click a cell to select it. Move with the arrow keys, extend with Shift, copy with{" "}
              {navigator.platform.includes("Mac") ? "⌘C" : "Ctrl+C"}.
            </span>
          )}
        </div>
        <button
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse cell value" : "Expand cell value"}
          className="preview-icon-button"
          onClick={() => setExpanded(!expanded)}
          type="button"
        >
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
        {active && (
          <button
            aria-label="Copy selected cells"
            className="preview-icon-button"
            onClick={() => void navigator.clipboard.writeText(selectedText()).catch(() => {})}
            type="button"
          >
            <Copy size={14} />
          </button>
        )}
      </div>
      <div className="spreadsheet-scroll bot-scrollbar" ref={scrollRef}>
        <table
          aria-colcount={cols + 1}
          aria-label={sheet.name}
          aria-multiselectable="true"
          aria-rowcount={sheet.rows.length}
          className="spreadsheet-grid"
          onCopy={(event) => {
            if (!bounds) return;
            event.preventDefault();
            event.clipboardData.setData("text/plain", selectedText());
          }}
          onKeyDown={onKeyDown}
          ref={gridRef}
          role="grid"
          style={{ width }}
          tabIndex={0}
        >
          <thead>
            <tr aria-rowindex={1} role="row" style={rowStyle}>
              <th role="rowheader">1</th>
              {Array.from({ length: cols }, (_, col) => cell(0, col, true))}
            </tr>
          </thead>
          <tbody style={{ height: totalSize, position: "relative", display: "block" }}>
            {virtualItems.map((item) => (
              <tr
                aria-rowindex={item.index + 2}
                key={item.key}
                role="row"
                style={{
                  ...rowStyle,
                  position: "absolute",
                  top: 0,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <th role="rowheader">{item.index + 2}</th>
                {Array.from({ length: cols }, (_, col) => cell(item.index + 1, col))}
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.total > sheet.rows.length - 1 && (
          <p className="preview-truncation">
            Showing the first {sheet.rows.length - 1} rows. Download to view the full workbook.
          </p>
        )}
      </div>
    </div>
  );
}
