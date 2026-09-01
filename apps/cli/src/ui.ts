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

export interface SetupPresentation {
  start(): void;
  stage(index: number): void;
  choices(items: readonly { title: string; description: string; recommended?: boolean }[]): void;
  message(message: string, tone?: MessageTone): void;
  summary(title: string, rows: readonly SetupSummaryRow[]): void;
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  white: "\u001b[97m",
} as const;

const colorEnabled = (
  environment: NodeJS.ProcessEnv = process.env,
  terminal = Boolean(stdout.isTTY)
): boolean => terminal && environment.NO_COLOR === undefined && environment.TERM !== "dumb";

const paint = (enabled: boolean, value: string, ...codes: string[]): string =>
  enabled ? `${codes.join("")}${value}${ANSI.reset}` : value;

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

export const renderSetupHeader = (input: {
  version: string;
  stages: readonly SetupStage[];
  activeStage: number;
  color?: boolean;
  width?: number;
}): string => {
  const styled = input.color ?? false;
  const width = Math.max(32, Math.min(96, input.width ?? 78));
  const heading = ` OPENBOT SETUP · v${input.version} `;
  if (width < 68) {
    const stage = input.stages[input.activeStage];
    const markers = input.stages
      .map((_value, index) =>
        index < input.activeStage ? "✓" : index === input.activeStage ? "●" : "○"
      )
      .join(" ");
    const progress = truncate(
      `${markers}  ${input.activeStage + 1}/${input.stages.length} ${stage?.label || ""}`,
      width - 4
    );
    return [
      `${paint(styled, "╭─", ANSI.cyan)}${paint(styled, truncate(heading, width - 4), ANSI.bold, ANSI.white)}${paint(styled, "─".repeat(Math.max(1, width - truncate(heading, width - 4).length - 3)) + "╮", ANSI.cyan)}`,
      `${paint(styled, "│", ANSI.cyan)} ${progress.padEnd(width - 3)}${paint(styled, "│", ANSI.cyan)}`,
      `${paint(styled, `╰${"─".repeat(width - 2)}╯`, ANSI.cyan)}`,
    ].join("\n");
  }
  const rightRule = "─".repeat(Math.max(1, width - heading.length - 3));
  const rawParts = input.stages.map((stage, index) => {
    const marker = index < input.activeStage ? "✓" : index === input.activeStage ? "●" : "○";
    return `${marker} ${stage.label}`;
  });
  const progress = rawParts
    .map((value, index) => {
      if (index < input.activeStage) return paint(styled, value, ANSI.green);
      if (index === input.activeStage) return paint(styled, value, ANSI.bold, ANSI.cyan);
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

export const createSetupPresentation = (input: {
  version: string;
  stages: readonly SetupStage[];
  write?: (value: string) => void;
  color?: boolean;
  width?: number;
}): SetupPresentation => {
  const write = input.write ?? ((value: string) => console.log(value));
  const styled = input.color ?? colorEnabled();
  const width = Math.max(32, Math.min(96, input.width ?? stdout.columns ?? 78));
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
        "A few guided steps, then OpenBot will verify the whole deployment.",
        width
      )) {
        write(paint(styled, line, ANSI.dim));
      }
      started = true;
    },
    stage(index) {
      const showHeader = !started || index !== activeStage;
      activeStage = index;
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
      const mark = { info: "•", success: "✓", warning: "!", muted: "·" }[tone];
      const codes = {
        info: [ANSI.cyan],
        success: [ANSI.green],
        warning: [ANSI.yellow],
        muted: [ANSI.dim],
      }[tone];
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
