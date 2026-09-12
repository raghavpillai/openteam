import type { DoctorCheck, DoctorResult } from "./doctor";
import { colorEnabled } from "./ui";
import { cleanTerminalText as clean, wrapTerminalText as wrap } from "./terminal";

const scopedCommands = (text: string, result: DoctorResult): string => {
  if (!result.commandDirectory) return text;
  const path = `'${result.commandDirectory.replace(/'/g, "'\\''")}'`;
  return text.replace(
    /openteam (provider list|model list|install|setup|start|doctor|logs|update)\b/g,
    (command) => `${command} --dir ${path}`
  );
};

export const doctorNextSteps = (result: DoctorResult): string[] => {
  const checks = result.checks;
  const failed = (label: string) => checks.some((c) => c.label === label && c.level === "fail");
  const steps: string[] = [];
  if (failed("Docker daemon") || failed("Docker CLI") || failed("Docker Compose"))
    steps.push("Start or repair Docker, then run openteam doctor again.");
  if (!result.installed) steps.push("Run openteam install to complete the installation.");
  else if (failed("Installation"))
    steps.push("Repair the installation manifest before starting OpenTeam.");
  else if (failed("Owner account"))
    steps.push("Run openteam setup to finish account and provider setup.");
  else if (failed("Compose services"))
    steps.push("Run openteam start to start the missing services.");
  if (failed("Schema setup") || failed("Database"))
    steps.push("Inspect openteam logs migrate and openteam logs postgres.");
  if (failed("Run leases"))
    steps.push("Inspect openteam logs worker for tasks with expired leases.");
  if (failed("Worker heartbeat"))
    steps.push("Inspect openteam logs worker; older images need openteam update --force.");
  else if (failed("Queue round trip"))
    steps.push("Inspect openteam logs worker for queue or database errors.");
  if (failed("Computer API"))
    steps.push("Inspect openteam logs computer for startup or connection errors.");
  if (checks.some((c) => c.label.includes("storage") && c.level === "fail"))
    steps.push("Check the reported volume permissions and openteam logs computer.");
  if (
    checks.some((c) => ["Inference", "AI connection"].includes(c.label) && c.level !== "pass") &&
    !failed("OpenTeam health") &&
    !failed("Owner account")
  )
    steps.push(
      "Run openteam provider list to check sign-in, then openteam model list to check available models."
    );
  if (failed("Transcription"))
    steps.push(
      "Open Settings → Server → Transcription, check the provider URL, model and key, then use Test connection."
    );
  if (!steps.length && !result.ok)
    steps.push("Resolve the failed checks above, then run openteam doctor again.");
  return steps.map((step) => scopedCommands(step, result));
};

const group = ({ label }: DoctorCheck): string => {
  if (label === "Transcription") return "VOICE NOTES";
  if (["Inference", "AI connection"].includes(label)) return "AI CONNECTION";
  if (label.includes("storage")) return "STORAGE";
  if (
    label.includes("container") ||
    [
      "Container health",
      "Compose services",
      "OpenTeam health",
      "Computer API",
      "Database",
      "Pending jobs",
      "Run leases",
      "Schema setup",
      "Worker heartbeat",
      "Queue round trip",
    ].includes(label)
  )
    return "SERVICES";
  return "HOST & SETUP";
};

export const renderDoctor = (
  result: DoctorResult,
  options: { color?: boolean; width?: number } = {}
): string => {
  const color = options.color ?? colorEnabled();
  const width = Math.max(24, Math.min(110, options.width ?? process.stdout.columns ?? 90));
  const paint = (text: string, code: number) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const tones = { pass: 32, warn: 33, fail: 31 };
  const marks = { pass: "✓", warn: "!", fail: "✗" };
  const failed = result.checks.filter((c) => c.level === "fail").length;
  const warnings = result.checks.filter((c) => c.level === "warn").length;
  const passed = result.checks.length - failed - warnings;
  const state = !result.installed
    ? "SETUP NEEDED"
    : !result.ok
      ? "NEEDS ATTENTION"
      : warnings
        ? "READY WITH NOTES"
        : "ALL SYSTEMS READY";
  const tone = failed ? 31 : warnings || !result.installed ? 33 : 32;
  const inside = width - 4;
  const frame = (text: string) => {
    const visible = text.replace(/\x1b\[[0-9;]*m/g, "").length;
    return `  ${paint("│", 36)} ${text}${" ".repeat(Math.max(0, width - 6 - visible))} ${paint("│", 36)}`;
  };
  const lines = [
    "",
    `  ${paint("╭" + "─".repeat(width - 4) + "╮", 36)}`,
    frame(paint("OPENTEAM", 1) + paint(width < 30 ? " / doctor" : "  /  doctor", 90)),
    frame(paint(state, tone)),
    `  ${paint("╰" + "─".repeat(width - 4) + "╯", 36)}`,
  ];
  for (const line of wrap(
    `${passed} passed   ${warnings} ${warnings === 1 ? "warning" : "warnings"}   ${failed} failed`,
    inside
  ))
    lines.push(`  ${paint(line, 90)}`);
  if (result.elapsedMs !== undefined)
    lines.push(`  ${paint(`Completed in ${(result.elapsedMs / 1000).toFixed(1)}s`, 90)}`);
  for (const name of ["SERVICES", "AI CONNECTION", "VOICE NOTES", "STORAGE", "HOST & SETUP"]) {
    const checks = result.checks.filter((c) => group(c) === name);
    if (!checks.length) continue;
    lines.push(
      "",
      `  ${paint(name, 1)} ${paint("─".repeat(Math.max(0, width - name.length - 4)), 90)}`
    );
    for (const check of checks) {
      const prefix = `  ${paint(marks[check.level], tones[check.level])} `;
      const label = clean(check.label);
      if (width >= 76 && label.length <= 22) {
        const details = wrap(scopedCommands(check.detail, result), width - 29);
        lines.push(
          `${prefix}${paint(label.padEnd(23), check.level === "fail" ? 31 : 1)}  ${paint(details[0]!, check.level === "pass" ? 90 : tones[check.level])}`
        );
        for (const line of details.slice(1))
          lines.push(
            `                             ${paint(line, check.level === "pass" ? 90 : tones[check.level])}`
          );
      } else {
        const labels = wrap(label, width - 4);
        lines.push(prefix + paint(labels[0]!, 1));
        for (const line of labels.slice(1)) lines.push(`    ${paint(line, 1)}`);
        for (const line of wrap(scopedCommands(check.detail, result), width - 6))
          lines.push(`      ${paint(line, check.level === "pass" ? 90 : tones[check.level])}`);
      }
    }
  }
  const steps = doctorNextSteps(result);
  if (steps.length) {
    lines.push("", `  ${paint("NEXT STEPS", 1)}`);
    for (const [index, step] of steps.entries()) {
      const parts = wrap(step, width - 6);
      lines.push(`  ${paint(`${index + 1}.`, 36)} ${parts[0]}`);
      for (const part of parts.slice(1)) lines.push(`     ${part}`);
    }
  }
  lines.push(
    "",
    ...wrap(
      result.ok
        ? "No blocking problems found. Doctor finished without starting services."
        : "Doctor finished with blocking problems. Exit code 2.",
      width - 4
    ).map((line) => `  ${paint(line, failed ? 31 : 90)}`),
    ""
  );
  return lines.join("\n");
};
