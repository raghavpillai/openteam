import { stripVTControlCharacters } from "node:util";
import { redactSensitiveText } from "@openteam/product-core/redaction";
import { colorEnabled } from "./ui";

export type TerminalTone = "info" | "success" | "warning" | "error" | "muted";
export interface TerminalOptions {
  color?: boolean;
  width?: number;
}
const codes = { info: 36, success: 32, warning: 33, error: 31, muted: 90 };
const marks = { info: "◇", success: "✓", warning: "!", error: "✗", muted: "·" };

export const cleanTerminalText = (text: string): string =>
  stripVTControlCharacters(redactSensitiveText(text)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export const wrapTerminalText = (text: string, width: number): string[] => {
  const limit = Math.max(1, width);
  const lines: string[] = [];
  let rest = cleanTerminalText(text).trim();
  while (rest.length > limit) {
    const space = rest.lastIndexOf(" ", limit);
    const split = space > limit / 2 ? space : limit;
    lines.push(rest.slice(0, split));
    rest = rest.slice(split).trimStart();
  }
  return [...lines, rest];
};

/** Shared presentation for human output. Callers keep JSON and raw log streams separate. */
export class TerminalReport {
  readonly width: number;
  readonly color: boolean;
  readonly lines: string[] = [];

  constructor(options: TerminalOptions = {}) {
    const columns = options.width ?? process.stdout.columns ?? 90;
    this.width = Math.max(
      24,
      Math.min(110, Number.isFinite(columns) && columns > 0 ? columns : 90)
    );
    this.color = options.color ?? colorEnabled();
  }

  paint(text: string, tone: TerminalTone | "bold" = "muted"): string {
    const safe = cleanTerminalText(text);
    return this.color ? `\x1b[${tone === "bold" ? 1 : codes[tone]}m${safe}\x1b[0m` : safe;
  }

  header(command: string, status?: string, tone: TerminalTone = "info"): this {
    const frame = (text: string, style: TerminalTone | "bold") => {
      for (const line of wrapTerminalText(text, this.width - 6)) {
        this.lines.push(
          `  ${this.paint("│", "info")} ${this.paint(line, style)}${" ".repeat(this.width - 6 - line.length)} ${this.paint("│", "info")}`
        );
      }
    };
    this.lines.push("", `  ${this.paint("╭" + "─".repeat(this.width - 4) + "╮", "info")}`);
    frame(`OPENTEAM / ${command}`, "bold");
    if (status) frame(status, tone);
    this.lines.push(`  ${this.paint("╰" + "─".repeat(this.width - 4) + "╯", "info")}`);
    return this;
  }

  section(title: string): this {
    if (this.lines.at(-1) !== "") this.lines.push("");
    for (const line of wrapTerminalText(title.toUpperCase(), this.width - 4)) {
      this.lines.push(
        `  ${this.paint(line, "bold")} ${this.paint("─".repeat(Math.max(0, this.width - line.length - 4)))}`
      );
    }
    return this;
  }

  text(text: string, tone: TerminalTone = "muted", indent = 2): this {
    for (const line of wrapTerminalText(text, this.width - indent))
      this.lines.push(" ".repeat(indent) + this.paint(line, tone));
    return this;
  }

  row(
    label: string,
    value: string,
    options: { tone?: TerminalTone; mark?: string; labelWidth?: number; active?: boolean } = {}
  ): this {
    const tone = options.tone ?? "muted";
    const labelWidth = options.labelWidth ?? 22;
    const prefix = options.mark ? `  ${this.paint(options.mark, tone)} ` : "    ";
    const safeLabel = cleanTerminalText(label);
    const labelTone = options.active ? "info" : "bold";
    if (this.width >= 76 && safeLabel.length <= labelWidth && labelWidth <= this.width / 2) {
      const indent = labelWidth + 6;
      const parts = wrapTerminalText(value, this.width - indent);
      this.lines.push(
        prefix +
          this.paint(safeLabel.padEnd(labelWidth), labelTone) +
          "  " +
          this.paint(parts[0]!, tone)
      );
      for (const part of parts.slice(1))
        this.lines.push(" ".repeat(indent) + this.paint(part, tone));
    } else {
      const labels = wrapTerminalText(safeLabel, this.width - 4);
      this.lines.push(prefix + this.paint(labels[0]!, labelTone));
      for (const line of labels.slice(1)) this.lines.push("    " + this.paint(line, labelTone));
      this.text(value, tone, 6);
    }
    return this;
  }

  notice(text: string, tone: TerminalTone = "info"): this {
    const lines = wrapTerminalText(text, this.width - 4);
    this.lines.push(`  ${this.paint(marks[tone], tone)} ${this.paint(lines[0]!, tone)}`);
    for (const line of lines.slice(1)) this.lines.push("    " + this.paint(line, tone));
    return this;
  }

  toString(): string {
    return this.lines.join("\n");
  }
}

export const printMessage = (text: string, tone: TerminalTone = "info"): void => {
  console.log(new TerminalReport().notice(text, tone).toString());
};
