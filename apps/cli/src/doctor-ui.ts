import type { DoctorCheck, DoctorResult } from "./doctor";
import { MINIMUM_COMPOSE_VERSION } from "./docker";
import { colorEnabled } from "./ui";
import {
  cleanTerminalText as clean,
  wrapTerminalText as wrap,
  TerminalReport,
  terminalTextWidth,
} from "./terminal";

const scopedCommands = (text: string, result: DoctorResult): string => {
  if (!result.commandDirectory) return text;
  const path = `'${result.commandDirectory.replace(/'/g, result.platform === "win32" ? "''" : "'\\''")}'`;
  return text.replace(
    /openteam (provider list|model list|install|setup|start|status|doctor|logs|update)\b(?! --dir\b)/g,
    (command) => `${command} --dir ${path}`
  );
};

const checkAction = (check: DoctorCheck): string | undefined => {
  if (check.action) return check.action;
  switch (check.label) {
    case "Platform":
      return "Install the OpenTeam server on an x64 or arm64 host.";
    case "Memory":
      return "Use a host with at least 8 GiB of RAM for the OpenTeam server.";
    case "Disk":
      return "Free space on the installation disk. For a new installation, choose a disk with more space using openteam install --dir <path>.";
    case "Installation directory":
      return "Check that your user can write to the reported directory, or choose a writable directory with openteam install --dir <path>.";
    case "Docker CLI":
      return "Install or repair Docker, then open a new terminal and run docker --version.";
    case "Docker daemon":
      return "Start your Docker runtime and wait for its engine to be ready. Run docker info; if it fails, inspect docker context ls and any DOCKER_HOST or DOCKER_CONTEXT overrides.";
    case "Docker Compose":
      return `Install or update Docker Desktop or the Compose plugin to ${MINIMUM_COMPOSE_VERSION} or newer. Verify with docker compose version (or docker-compose version).`;
    case "Installation":
      return check.level === "fail"
        ? "Restore the missing or invalid installation files from a known-good backup, or use openteam install --dir <path> for a separate new installation."
        : undefined;
    case "Local ports":
      return check.level === "fail"
        ? "Identify which application is using the reported port. Stop it if appropriate, or choose another API port during guided installation or openteam setup; the screen-viewer ports must be available."
        : undefined;
    case "Secrets":
      return "Restrict the reported configuration file to owner-only access before starting OpenTeam.";
    case "Secret values":
      return "Restore the missing or invalid secrets from a known-good installation backup; the database and service credentials must remain consistent.";
    case "Configuration":
    case "Compose configuration":
      return "Correct the reported error in the installation's configuration files, or restore them from a known-good backup before starting OpenTeam.";
    case "Owner account":
      return "Run openteam setup to finish account and provider setup.";
    case "Network exposure":
      return "Run openteam setup to review the access mode, public URL, and bind addresses. Use HTTPS for public access; keep private HTTP behind a trusted LAN or VPN.";
    case "Compose services":
      if (!/^not running:/i.test(check.detail))
        return "Docker could not list the services. Run docker info, then inspect the reported Compose error before trying openteam status again.";
      return "Run openteam start to start the missing services. If startup fails, inspect openteam logs.";
    case "Container health":
    case "OpenTeam health":
      if (/expected release|was not reported/i.test(check.detail))
        return "Run openteam status to check which server release is running. Verify the API port belongs to this installation before using openteam update to align its release.";
      if (/another.*(?:server|instance)|different.*instance|foreign/i.test(check.detail))
        return "Identify the OpenTeam instance using the reported API port. Use the intended installation's --dir path, or choose an unused API port in openteam setup.";
      return "Run openteam status and inspect openteam logs for unhealthy or stopped services; resolve the reported startup or connection error.";
    case "Schema setup":
    case "Database":
      return "Inspect openteam logs migrate and openteam logs postgres for database startup or migration errors.";
    case "Pending jobs":
    case "Run leases":
    case "Worker heartbeat":
    case "Queue round trip":
      if (/authenticated computer API/i.test(check.detail))
        return "Inspect openteam logs computer and confirm the worker and computer use the same installation control token.";
      if (/storage access/i.test(check.detail))
        return "Check the worker's agent and asset volume permissions. The worker must be able to read and write both volumes.";
      if (/database\/schema/i.test(check.detail))
        return "Inspect openteam logs postgres and openteam logs migrate; the worker needs the application tables and job queues.";
      return "Inspect openteam logs worker for stalled jobs, expired leases, or database connection errors.";
    case "Computer API":
      if (/HTTP (401|403)/i.test(check.detail))
        return "The computer rejected the server's credentials. Check that both services use the installation's OPENTEAM_CONTROL_TOKEN, then recreate the affected service with the corrected configuration.";
      return "Inspect openteam logs computer for startup or connection errors.";
    case "Public DNS":
      return "Check that the public hostname resolves to this server's reachable address, then retry after the DNS change has propagated.";
    case "TLS certificate":
      return "Check the public hostname and certificate on your HTTPS proxy. For bundled HTTPS, inspect openteam logs caddy and verify inbound ports 80 and 443 are reachable.";
    case "Public endpoint":
      return "Check the public URL, firewall, and reverse proxy; verify the proxy forwards HTTP and WebSocket traffic to OpenTeam's configured API port.";
    case "Inference":
    case "AI connection":
      if (/429|quota|billing|rate.?limit/i.test(check.detail))
        return "Check the model provider's quota or billing, or wait for its rate limit to reset. Use openteam model list to choose another available model if needed.";
      if (/401|403|invalid.*(?:key|token)|unauthorized|authentication/i.test(check.detail))
        return "Run openteam provider list to inspect the provider connection, then openteam setup to reconnect it.";
      if (/timed out|timeout|ECONNREFUSED|ENOTFOUND|network|connection refused/i.test(check.detail))
        return "Check network access from the server and computer services to the model provider, including proxy or VPN settings. Inspect openteam logs computer and retry openteam doctor.";
      if (/model.*(?:unavailable|not found|does not exist|not supported)/i.test(check.detail))
        return "Run openteam model list to see models available to the connected account, then use openteam setup to select one.";
      return "Run openteam provider list to check sign-in, then openteam model list to check available models. Use openteam setup to change the provider or model.";
    case "Transcription":
      if (/does not expose transcription diagnostics/i.test(check.detail))
        return "Run openteam update to get transcription diagnostics, then configure voice notes in Settings → Server → Transcription.";
      if (/server connection|installation credentials/i.test(check.detail))
        return "Run openteam status and check the server connection and installation control token. Inspect openteam logs server before testing transcription again.";
      return "Open Settings → Server → Transcription, check the provider URL, model and key, then use Test connection.";
  }
  if (check.label.includes("storage"))
    return "Check that the reported volume is writable by the service's user and has free space. Inspect openteam logs for storage errors.";
  if (check.label.endsWith(" container")) {
    const service = check.label.slice(0, -" container".length);
    if (["postgres", "server", "worker", "computer", "caddy"].includes(service))
      return `Inspect openteam logs ${service} to identify why the container stopped or became unhealthy.`;
  }
  return check.level === "fail"
    ? `Review the reported ${check.label} error and inspect openteam logs for further details.`
    : undefined;
};

export const isSkippedDoctorCheck = (check: DoctorCheck): boolean =>
  check.level === "warn" && /^not tested\b/i.test(check.detail.trim());

export const doctorNextSteps = (
  result: DoctorResult,
  options: { installInProgress?: boolean } = {}
): string[] => {
  const failed = (label: string) =>
    result.checks.some((c) => c.label === label && c.level === "fail");
  const dockerBlocked = ["Docker CLI", "Docker daemon", "Docker Compose"].some(failed);
  const steps: string[] = [];
  const actionable = [
    ...result.checks.filter((check) => check.level === "fail"),
    ...result.checks.filter((check) => check.level === "warn"),
  ];
  for (const check of actionable) {
    if (check.level === "pass") continue;
    // Resolve prerequisites before recommending dependent service or provider actions.
    if (
      dockerBlocked &&
      ["SERVICES", "AI CONNECTION", "VOICE NOTES", "STORAGE"].includes(group(check))
    )
      continue;
    if (dockerBlocked && check.label === "Owner account") continue;
    if (failed("Docker CLI") && check.label === "Docker Compose") continue;
    if (!result.installed && group(check) !== "HOST & SETUP") continue;
    if (failed("Owner account") && check.label === "Compose services") continue;
    if (
      ["Inference", "AI connection"].includes(check.label) &&
      (failed("OpenTeam health") || failed("Owner account"))
    )
      continue;
    if (isSkippedDoctorCheck(check)) continue;
    const action = checkAction(check);
    if (action) steps.push(action);
  }
  if (!result.installed && (!options.installInProgress || !result.ok))
    steps.push(
      result.ok
        ? "Run openteam install to complete the installation."
        : "After resolving the failed checks, run openteam install again."
    );
  else if (!result.ok) steps.push("After completing these steps, run openteam doctor again.");
  return [...new Set(steps)].map((step) => clean(scopedCommands(step, result)));
};

export const renderCompactDoctor = (
  result: DoctorResult,
  options: { color?: boolean; width?: number } = {}
): string => {
  const report = new TerminalReport(options);
  const visible = result.checks.filter((check) => check.level !== "pass");
  for (const check of visible) {
    if (isSkippedDoctorCheck(check)) {
      report.text(`– ${check.label}: ${scopedCommands(check.detail, result)}`);
      continue;
    }
    report.notice(
      `${check.label}: ${scopedCommands(check.detail, result)}`,
      check.level === "fail" ? "error" : "warning"
    );
    if (check.diagnostic) report.text(`Details: ${check.diagnostic}`, "muted", 4);
  }
  const failures = visible.filter((check) => check.level === "fail").length;
  const skipped = visible.filter(isSkippedDoctorCheck).length;
  const warnings = visible.length - failures - skipped;
  report.notice(
    failures
      ? `${failures} blocking ${failures === 1 ? "problem" : "problems"} found.`
      : warnings
        ? `Checks passed with ${warnings} ${warnings === 1 ? "warning" : "warnings"}.`
        : skipped
          ? `No blocking problems found; ${skipped} ${skipped === 1 ? "check was" : "checks were"} not completed.`
          : "All checks passed.",
    failures ? "error" : skipped ? "info" : "success"
  );
  const steps = doctorNextSteps(result, { installInProgress: true });
  if (steps.length) {
    report.section("Next steps");
    for (const [index, step] of steps.entries()) report.text(`${index + 1}. ${step}`, "info");
  }
  return report.toString();
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
  const width = new TerminalReport(options).width;
  const paint = (text: string, code: number) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const tones = { pass: 32, warn: 33, fail: 31 };
  const marks = { pass: "✓", warn: "!", fail: "✗" };
  const failed = result.checks.filter((c) => c.level === "fail").length;
  const skipped = result.checks.filter(isSkippedDoctorCheck).length;
  const warnings = result.checks.filter((c) => c.level === "warn").length - skipped;
  const passed = result.checks.length - failed - warnings - skipped;
  const state = !result.ok
    ? "NEEDS ATTENTION"
    : !result.installed
      ? "SETUP NEEDED"
      : skipped
        ? "CHECKS INCOMPLETE"
        : warnings
          ? "READY WITH NOTES"
          : "ALL SYSTEMS READY";
  const tone = failed ? 31 : warnings || skipped || !result.installed ? 33 : 32;
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
    `${passed} passed   ${warnings} ${warnings === 1 ? "warning" : "warnings"}   ${failed} failed${skipped ? `   ${skipped} not checked` : ""}`,
    inside
  ))
    lines.push(`  ${paint(line, 90)}`);
  if (result.elapsedMs !== undefined)
    lines.push(`  ${paint(`Completed in ${(result.elapsedMs / 1000).toFixed(1)}s`, 90)}`);
  const appendNextSteps = () => {
    const steps = doctorNextSteps(result);
    if (!steps.length) return;
    lines.push("", `  ${paint("NEXT STEPS", 1)}`);
    for (const [index, step] of steps.entries()) {
      const prefix = `${index + 1}. `;
      const parts = wrap(step, width - prefix.length - 2);
      lines.push(`  ${paint(prefix, 36)}${parts[0]}`);
      for (const part of parts.slice(1)) lines.push(`${" ".repeat(prefix.length + 2)}${part}`);
    }
  };
  if (!result.ok) appendNextSteps();
  const groups = ["HOST & SETUP", "SERVICES", "AI CONNECTION", "VOICE NOTES", "STORAGE"];
  const priority = { fail: 0, warn: 1, pass: 2 };
  for (const name of groups) {
    const checks = result.checks
      .filter((c) => group(c) === name)
      .sort((a, b) => priority[a.level] - priority[b.level]);
    if (!checks.length) continue;
    lines.push(
      "",
      `  ${paint(name, 1)} ${paint("─".repeat(Math.max(0, width - name.length - 4)), 90)}`
    );
    for (const check of checks) {
      const tone = isSkippedDoctorCheck(check) ? 90 : tones[check.level];
      const prefix = `  ${paint(isSkippedDoctorCheck(check) ? "–" : marks[check.level], tone)} `;
      const label = clean(check.label);
      if (width >= 76 && terminalTextWidth(label) <= 22) {
        const details = wrap(scopedCommands(check.detail, result), width - 29);
        lines.push(
          `${prefix}${paint(label + " ".repeat(23 - terminalTextWidth(label)), check.level === "fail" ? 31 : 1)}  ${paint(details[0]!, check.level === "pass" ? 90 : tone)}`
        );
        for (const line of details.slice(1))
          lines.push(
            `                             ${paint(line, check.level === "pass" ? 90 : tone)}`
          );
      } else {
        const labels = wrap(label, width - 4);
        lines.push(prefix + paint(labels[0]!, 1));
        for (const line of labels.slice(1)) lines.push(`    ${paint(line, 1)}`);
        for (const line of wrap(scopedCommands(check.detail, result), width - 6))
          lines.push(`      ${paint(line, check.level === "pass" ? 90 : tone)}`);
      }
      if (check.diagnostic)
        for (const line of wrap(`Details: ${check.diagnostic}`, width - 6))
          lines.push(`      ${paint(line, 90)}`);
    }
  }
  if (result.ok) appendNextSteps();
  lines.push(
    "",
    ...wrap(
      result.ok
        ? skipped
          ? "No blocking problems found. Some checks could not be completed; see the reasons above."
          : "No blocking problems found. Doctor finished without starting services."
        : "Doctor finished with blocking problems. Exit code 2.",
      width - 4
    ).map((line) => `  ${paint(line, failed ? 31 : 90)}`),
    ""
  );
  return lines.join("\n");
};
