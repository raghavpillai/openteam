import { stdout } from "node:process";

export type MessageTone = "info" | "success" | "warning" | "muted";

export interface SetupStage {
  label: string;
  description: string;
}

export interface SetupSummaryRow {
  label: string;
  value: string;
}

export interface SelectionPromptInput {
  message: string;
  options: readonly { label: string }[];
  index: number;
  color?: boolean;
  width?: number;
}

export interface SetupPresentation {
  start(): void;
  stage(index: number): void;
  choices(items: readonly { title: string; description: string; recommended?: boolean }[]): void;
  message(message: string, tone?: MessageTone): void;
  summary(title: string, rows: readonly SetupSummaryRow[]): void;
}

/** One line item inside an interactive setup section. */
export type SessionRow =
  | { kind: "heading"; text: string }
  | { kind: "note"; text: string; tone: MessageTone }
  | { kind: "field"; label: string; value: string }
  | {
      kind: "option";
      id: string;
      label: string;
      description?: string;
      selected: boolean;
      recommended?: boolean;
      /** Short green tag such as "detected"; joined with "recommended" when both apply. */
      badge?: string;
    }
  | {
      kind: "text";
      id: string;
      label: string;
      value: string;
      placeholder?: string;
      secret?: boolean;
      editing?: { buffer: string; error: string | null; label?: string };
    }
  | { kind: "toggle"; id: string; label: string; checked: boolean; description?: string }
  | { kind: "cycle"; id: string; label: string; value: string }
  | { kind: "action"; id: string; label: string; primary?: boolean };

export const SELECTABLE_ROW_KINDS = new Set<SessionRow["kind"]>([
  "option",
  "text",
  "toggle",
  "cycle",
  "action",
]);

export interface SetupSessionView {
  version: string;
  stages: readonly SetupStage[];
  activeStage: number;
  completed: readonly boolean[];
  title: string;
  description: string;
  rows: readonly SessionRow[];
  cursorRow: number;
  mode: "navigate" | "edit";
  notice: { text: string; tone: MessageTone } | null;
}

export interface SetupSessionFrame {
  header: readonly string[];
  body: readonly string[];
  footer: readonly string[];
  cursorLine: number;
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  inverse: "\u001b[7m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  white: "\u001b[97m",
} as const;

const TONE_MARKS: Record<MessageTone, string> = {
  info: "•",
  success: "✓",
  warning: "!",
  muted: "·",
};
const TONE_CODES: Record<MessageTone, string[]> = {
  info: [ANSI.cyan],
  success: [ANSI.green],
  warning: [ANSI.yellow],
  muted: [ANSI.dim],
};

export const colorEnabled = (
  environment: NodeJS.ProcessEnv = process.env,
  terminal = Boolean(stdout.isTTY)
): boolean => terminal && environment.NO_COLOR === undefined && environment.TERM !== "dumb";

const paint = (enabled: boolean, value: string, ...codes: string[]): string =>
  enabled ? `${codes.join("")}${value}${ANSI.reset}` : value;

const measuredWidth = (value: number | undefined, fallback = 78): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

const truncate = (value: string, width: number): string =>
  value.length <= width ? value : `${value.slice(0, Math.max(1, width - 1))}…`;

const wrapText = (value: string, width: number): string[] => {
  const limit = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const originalWord of words) {
      let word = originalWord;
      if (line && line.length + 1 + word.length <= limit) {
        line += ` ${word}`;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      while (word.length > limit) {
        lines.push(word.slice(0, limit));
        word = word.slice(limit);
      }
      line = word;
    }
    if (line) lines.push(line);
  }
  return lines;
};

export const renderSelectionPrompt = (input: SelectionPromptInput): readonly string[] => {
  const styled = input.color ?? colorEnabled();
  const width = Math.max(16, Math.min(80, measuredWidth(input.width ?? stdout.columns)));
  const hint =
    width >= 40 ? "  ↑/↓ move · Enter select" : width >= 21 ? "  arrows · Enter" : "  ↑↓ · Enter";
  const lines = [
    `${paint(styled, "?", ANSI.cyan)} ${paint(styled, truncate(input.message, width - 2), ANSI.bold)}`,
  ];
  for (const [index, option] of input.options.entries()) {
    const active = index === input.index;
    const prefix = active ? "  ❯ " : "    ";
    const label = truncate(option.label, Math.max(1, width - prefix.length));
    lines.push(
      active
        ? `${paint(styled, prefix, ANSI.cyan)}${paint(styled, label, ANSI.bold)}`
        : `${prefix}${paint(styled, label, ANSI.dim)}`
    );
  }
  lines.push(paint(styled, truncate(hint, width), ANSI.dim));
  return lines;
};

export const renderSelectionResult = (
  message: string,
  label: string,
  color = colorEnabled(),
  width = stdout.columns ?? 78
): string => {
  const limit = Math.max(16, Math.min(80, measuredWidth(width)));
  const available = limit - 4;
  const fits = message.length + label.length <= available;
  const labelWidth = fits
    ? label.length
    : Math.max(7, Math.min(label.length, Math.floor(available / 2)));
  const messageWidth = Math.max(1, available - labelWidth);
  return `${paint(color, "✓", ANSI.green)} ${paint(color, truncate(message, messageWidth), ANSI.dim)}  ${paint(color, truncate(label, labelWidth), ANSI.bold)}`;
};

export const renderSetupHeader = (input: {
  version: string;
  stages: readonly SetupStage[];
  activeStage: number;
  completed?: readonly boolean[];
  color?: boolean;
  width?: number;
}): string => {
  const styled = input.color ?? false;
  const width = Math.max(32, Math.min(96, measuredWidth(input.width)));
  const heading = ` OPENTEAM SETUP · v${input.version} `;
  const markerFor = (index: number): "done" | "active" | "pending" => {
    if (index === input.activeStage) return "active";
    const done = input.completed ? Boolean(input.completed[index]) : index < input.activeStage;
    return done ? "done" : "pending";
  };
  const markers = { done: "✓", active: "●", pending: "○" } as const;
  if (width < 68) {
    const stage = input.stages[input.activeStage];
    const compact = input.stages.map((_value, index) => markers[markerFor(index)]).join(" ");
    const progress = truncate(
      `${compact}  ${input.activeStage + 1}/${input.stages.length} ${stage?.label || ""}`,
      width - 4
    );
    return [
      `${paint(styled, "╭─", ANSI.cyan)}${paint(styled, truncate(heading, width - 4), ANSI.bold, ANSI.white)}${paint(styled, `${"─".repeat(Math.max(1, width - truncate(heading, width - 4).length - 3))}╮`, ANSI.cyan)}`,
      `${paint(styled, "│", ANSI.cyan)} ${progress.padEnd(width - 3)}${paint(styled, "│", ANSI.cyan)}`,
      `${paint(styled, `╰${"─".repeat(width - 2)}╯`, ANSI.cyan)}`,
    ].join("\n");
  }
  const rightRule = "─".repeat(Math.max(1, width - heading.length - 3));
  const rawParts = input.stages.map(
    (stage, index) => `${markers[markerFor(index)]} ${stage.label}`
  );
  const progress = rawParts
    .map((value, index) => {
      const marker = markerFor(index);
      if (marker === "done") return paint(styled, value, ANSI.green);
      if (marker === "active") return paint(styled, value, ANSI.bold, ANSI.cyan);
      return paint(styled, value, ANSI.dim);
    })
    .join(paint(styled, "  ─  ", ANSI.dim));
  const rawProgress = `  ${rawParts.join("  ─  ")}`;
  const progressPadding = " ".repeat(Math.max(0, width - 2 - rawProgress.length));
  return [
    `${paint(styled, "╭─", ANSI.cyan)}${paint(styled, heading, ANSI.bold, ANSI.white)}${paint(styled, `${rightRule}╮`, ANSI.cyan)}`,
    `${paint(styled, "│", ANSI.cyan)}  ${progress}${progressPadding}${paint(styled, "│", ANSI.cyan)}`,
    `${paint(styled, `╰${"─".repeat(width - 2)}╯`, ANSI.cyan)}`,
  ].join("\n");
};

const noteLines = (text: string, tone: MessageTone, width: number, styled: boolean): string[] => {
  const mark = TONE_MARKS[tone];
  const codes = TONE_CODES[tone];
  return wrapText(text, width - 4).map((line, index) => {
    const prefix = index === 0 ? `  ${paint(styled, mark, ...codes)} ` : "    ";
    return `${prefix}${paint(styled, line, ...codes)}`;
  });
};

/**
 * Render one frame of the interactive setup session. The body carries the section
 * title and rows; the header and footer are pinned by the terminal driver so the
 * body can scroll independently inside short terminals.
 */
export const renderSetupSession = (
  input: SetupSessionView & { color?: boolean; width?: number }
): SetupSessionFrame => {
  const styled = input.color ?? colorEnabled();
  const width = Math.max(32, Math.min(100, measuredWidth(input.width ?? stdout.columns)));
  const header = renderSetupHeader({
    version: input.version,
    stages: input.stages,
    activeStage: input.activeStage,
    completed: input.completed,
    color: styled,
    width: Math.min(width, 96),
  }).split("\n");

  const body: string[] = [];
  body.push(paint(styled, truncate(input.title, width), ANSI.bold, ANSI.white));
  for (const line of wrapText(input.description, width)) body.push(paint(styled, line, ANSI.dim));

  const labelWidth = Math.min(
    24,
    Math.max(
      8,
      ...input.rows.map((row) =>
        row.kind === "text" || row.kind === "cycle" || row.kind === "field"
          ? (row.kind === "text" ? (row.editing?.label ?? row.label) : row.label).length
          : 0
      )
    )
  );
  const valueWidth = Math.max(8, width - 4 - labelWidth - 2);
  let cursorLine = -1;
  let previousKind: SessionRow["kind"] | null = null;

  for (const [index, row] of input.rows.entries()) {
    const active = index === input.cursorRow;
    if (
      row.kind === "heading" ||
      (row.kind === "field" && previousKind === "option") ||
      (row.kind === "action" && previousKind !== "action") ||
      (row.kind === "note" && previousKind !== "note" && previousKind !== null)
    ) {
      body.push("");
    }
    if (active) cursorLine = body.length;
    const pointer = active ? paint(styled, "❯", ANSI.cyan) : " ";
    switch (row.kind) {
      case "heading":
        body.push(`  ${paint(styled, truncate(row.text, width - 2), ANSI.bold)}`);
        break;
      case "note":
        body.push(...noteLines(row.text, row.tone, width, styled));
        break;
      case "field": {
        const label = truncate(row.label, labelWidth).padEnd(labelWidth);
        body.push(`    ${paint(styled, label, ANSI.dim)}  ${truncate(row.value, valueWidth)}`);
        break;
      }
      case "option": {
        const marker = row.selected ? paint(styled, "●", ANSI.green) : paint(styled, "○", ANSI.dim);
        const tags = [row.badge, row.recommended ? "recommended" : null]
          .filter(Boolean)
          .join(" · ");
        const badge = tags ? paint(styled, `  ${tags}`, ANSI.green) : "";
        const badgeWidth = tags ? tags.length + 2 : 0;
        const label = truncate(row.label, Math.max(1, width - 6 - badgeWidth));
        body.push(
          `  ${pointer} ${marker} ${active || row.selected ? paint(styled, label, ANSI.bold) : label}${badge}`
        );
        if (row.description && active) {
          for (const line of wrapText(row.description, width - 6)) {
            body.push(`      ${paint(styled, line, ANSI.dim)}`);
          }
        }
        break;
      }
      case "text": {
        const editing = row.editing;
        const label = truncate(editing?.label ?? row.label, labelWidth).padEnd(labelWidth);
        let value: string;
        if (editing) {
          const shown = row.secret ? "•".repeat(editing.buffer.length) : editing.buffer;
          const clipped =
            shown.length > valueWidth - 1 ? shown.slice(shown.length - (valueWidth - 1)) : shown;
          value = `${paint(styled, clipped, ANSI.bold)}${paint(styled, " ", ANSI.inverse)}`;
        } else if (row.value) {
          value = row.secret
            ? paint(styled, "••••••••", ANSI.dim)
            : active
              ? paint(styled, truncate(row.value, valueWidth), ANSI.bold)
              : truncate(row.value, valueWidth);
        } else {
          value = paint(styled, truncate(row.placeholder ?? "not set", valueWidth), ANSI.dim);
        }
        body.push(`  ${pointer} ${active ? paint(styled, label, ANSI.bold) : label}  ${value}`);
        if (editing?.error) {
          body.push(
            ...noteLines(editing.error, "warning", width, styled).map((line) => `  ${line}`)
          );
        }
        break;
      }
      case "toggle": {
        const box = row.checked ? paint(styled, "[x]", ANSI.green) : paint(styled, "[ ]", ANSI.dim);
        const label = truncate(row.label, Math.max(1, width - 8));
        body.push(`  ${pointer} ${box} ${active ? paint(styled, label, ANSI.bold) : label}`);
        if (row.description) {
          for (const line of wrapText(row.description, width - 8)) {
            body.push(`        ${paint(styled, line, ANSI.dim)}`);
          }
        }
        break;
      }
      case "cycle": {
        const label = truncate(row.label, labelWidth).padEnd(labelWidth);
        const value = `‹ ${truncate(row.value, Math.max(1, valueWidth - 4))} ›`;
        body.push(
          `  ${pointer} ${active ? paint(styled, label, ANSI.bold) : label}  ${active ? paint(styled, value, ANSI.bold) : value}`
        );
        break;
      }
      case "action": {
        const label = truncate(row.label, Math.max(1, width - 4));
        const codes = row.primary ? [ANSI.bold, ANSI.green] : active ? [ANSI.bold] : [];
        body.push(`  ${pointer} ${paint(styled, label, ...codes)}`);
        break;
      }
    }
    previousKind = row.kind;
  }

  const footer: string[] = [""];
  if (input.notice) footer.push(...noteLines(input.notice.text, input.notice.tone, width, styled));
  const focused = input.cursorRow >= 0 ? input.rows[input.cursorRow] : undefined;
  let hint: string;
  if (input.mode === "edit") {
    hint = width >= 48 ? "  Type to edit · Enter save · Esc discard" : "  Enter save · Esc discard";
  } else if (!focused) {
    hint = width < 40 ? "  ←→ · Esc" : "  ←/→ step · Esc cancel";
  } else if (width < 40) {
    hint = "  ↑↓ · Enter · ←→ · Esc";
  } else if (width < 64) {
    hint = "  ↑↓ move · Enter · ←→ · Esc cancel";
  } else if (focused?.kind === "text") {
    hint = focused.value
      ? "  Type to replace · Enter keep · ↑/↓ move · ←/→ step · Esc cancel"
      : "  Type to enter · Enter edit · ↑/↓ move · ←/→ step · Esc cancel";
  } else if (focused?.kind === "toggle" || focused?.kind === "cycle") {
    hint = "  ↑/↓ move · Enter change · ←/→ step · Esc cancel";
  } else if (focused?.kind === "action") {
    hint = "  ↑/↓ choose · Enter confirm · ← back · Esc cancel";
  } else {
    hint = "  ↑/↓ choose · Enter confirm · ←/→ step · Esc cancel";
  }
  footer.push(paint(styled, truncate(hint, width), ANSI.dim));
  return { header, body, footer, cursorLine };
};

/**
 * Keep a scrolling body within `maxLines`, always keeping the focused line visible.
 * Returns the lines to draw plus the offset to remember for the next frame.
 */
export const clampViewport = (
  lines: readonly string[],
  focusLine: number,
  maxLines: number,
  previousOffset = 0,
  color = false
): { lines: readonly string[]; offset: number } => {
  const limit = Math.max(3, maxLines);
  if (lines.length <= limit) return { lines, offset: 0 };
  const window = limit - 2;
  let offset = Math.max(0, Math.min(previousOffset, lines.length - window));
  const focus = focusLine < 0 ? offset : focusLine;
  if (focus < offset) offset = focus;
  if (focus >= offset + window) offset = focus - window + 1;
  offset = Math.max(0, Math.min(offset, lines.length - window));
  const above = offset;
  const below = lines.length - offset - window;
  return {
    offset,
    lines: [
      above > 0 ? paint(color, `  ↑ ${above} more`, ANSI.dim) : "",
      ...lines.slice(offset, offset + window),
      below > 0 ? paint(color, `  ↓ ${below} more`, ANSI.dim) : "",
    ],
  };
};

export const createSetupPresentation = (input: {
  version: string;
  stages: readonly SetupStage[];
  write?: (value: string) => void;
  color?: boolean;
  width?: number;
}): SetupPresentation => {
  const write = input.write ?? ((value: string) => console.log(value));
  const styled = input.color ?? colorEnabled();
  const width = Math.max(32, Math.min(96, measuredWidth(input.width ?? stdout.columns)));
  let activeStage = 0;
  let started = false;

  const header = () =>
    renderSetupHeader({
      version: input.version,
      stages: input.stages,
      activeStage,
      color: styled,
      width,
    });

  return {
    start() {
      write(header());
      for (const line of wrapText(
        "A few quick choices, then OpenTeam will check the rest.",
        width
      )) {
        write(paint(styled, line, ANSI.dim));
      }
      started = true;
    },
    stage(index) {
      const showHeader = !started || index !== activeStage;
      activeStage = index;
      started = true;
      if (showHeader) write(`\n${header()}`);
      const stage = input.stages[index];
      if (!stage) return;
      write(`\n${paint(styled, `${index + 1}. ${stage.label}`, ANSI.bold, ANSI.white)}`);
      for (const line of wrapText(stage.description, width)) {
        write(paint(styled, line, ANSI.dim));
      }
    },
    choices(items) {
      for (const [index, item] of items.entries()) {
        const badge = item.recommended ? paint(styled, " recommended", ANSI.green) : "";
        write(
          `  ${paint(styled, String(index + 1), ANSI.bold, ANSI.cyan)}  ${paint(styled, item.title, ANSI.bold)}${badge}`
        );
        for (const line of wrapText(item.description, width - 5)) {
          write(`     ${paint(styled, line, ANSI.dim)}`);
        }
      }
      write("");
    },
    message(message, tone = "info") {
      const mark = TONE_MARKS[tone];
      const codes = TONE_CODES[tone];
      for (const [index, line] of wrapText(message, width - 2).entries()) {
        const prefix = index === 0 ? `${paint(styled, mark, ...codes)} ` : "  ";
        write(`${prefix}${paint(styled, line, ...codes)}`);
      }
    },
    summary(title, rows) {
      const labelWidth = Math.max(6, ...rows.map((row) => row.label.length));
      write(`\n${paint(styled, `✓ ${title}`, ANSI.bold, ANSI.green)}`);
      for (const row of rows) {
        const prefix = `  ${row.label.padEnd(labelWidth)}  `;
        const lines = wrapText(row.value, Math.max(12, width - prefix.length));
        for (const [index, line] of lines.entries()) {
          write(
            `${index === 0 ? `  ${paint(styled, row.label.padEnd(labelWidth), ANSI.dim)}  ` : " ".repeat(prefix.length)}${line}`
          );
        }
      }
    },
  };
};
