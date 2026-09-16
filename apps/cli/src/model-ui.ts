import { TerminalReport, type TerminalOptions, wrapTerminalText } from "./terminal";
import type { SetupSessionFrame, SetupSessionView } from "./ui";

export const renderModelSession = (
  input: SetupSessionView,
  options: TerminalOptions & { compact?: boolean } = {}
): SetupSessionFrame => {
  const header = new TerminalReport(options);
  if (options.compact) header.text("OPENTEAM / model", "info");
  else header.header("model", `VERSION ${input.version}`);
  const tabs = input.stages
    .map((stage, index) => (index === input.activeStage ? `[${stage.label}]` : stage.label))
    .join("  |  ");
  header.text(`‹ ${tabs} ›`, "info");
  if (!options.compact) header.lines.push("");
  const body = new TerminalReport(options);
  body.section(input.title);
  body.text(input.description);
  if (!options.compact) body.lines.push("");
  let cursorLine = -1;
  let cursorEndLine: number | undefined;
  for (const [index, row] of input.rows.entries()) {
    const focused = index === input.cursorRow;
    if (focused) cursorLine = body.lines.length;
    const mark = focused ? "❯" : row.kind === "option" ? (row.selected ? "●" : "○") : " ";
    const tone = focused ? "info" : "muted";
    if (row.kind === "note") body.text(row.text, row.tone);
    else if (row.kind === "heading") body.section(row.text);
    else if (row.kind === "option") {
      body.row(row.label, row.badge ?? (row.selected ? "Selected" : ""), {
        mark,
        tone,
        active: focused,
      });
      if (focused && row.description) body.text(row.description);
      if (focused) cursorEndLine = body.lines.length - 1;
    } else if (row.kind === "text") {
      const buffer = row.editing?.buffer;
      const shown = row.secret
        ? buffer !== undefined
          ? "•".repeat(Math.min(buffer.length, 20))
          : row.value
            ? "••••••••"
            : (row.placeholder ?? "Not set")
        : buffer !== undefined
          ? buffer
          : row.value || row.placeholder || "Not set";
      body.row(row.label, `${shown}${buffer !== undefined ? " ▏" : ""}`, {
        mark,
        tone,
        active: focused,
      });
      if (row.editing?.error) body.text(row.editing.error, "warning");
      if (focused && row.editing) cursorLine = body.lines.length - 1;
    } else if (row.kind === "toggle")
      body.row(row.label, row.checked ? "On" : "Off", { mark, tone, active: focused });
    else if (row.kind === "action")
      body.text(`${mark} ${row.label}`, focused ? "info" : row.primary ? "success" : tone);
    else body.row(row.label, row.value, { mark, tone, active: focused });
  }
  const footer = new TerminalReport(options);
  footer.lines.push("");
  if (input.notice) footer.text(input.notice.text, input.notice.tone);
  const hint =
    input.mode === "edit"
      ? "Enter keeps edit · Esc discards edit"
      : "←/→ tabs · ↑/↓ move · Enter choose · Esc back";
  for (const line of wrapTerminalText(hint, footer.width - 4)) footer.text(line);
  return {
    header: header.lines,
    body: body.lines,
    footer: footer.lines,
    cursorLine,
    cursorEndLine,
  };
};
