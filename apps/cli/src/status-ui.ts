import type { HealthResult } from "./health";
import type { ServiceState } from "./startup";
import { TerminalReport, type TerminalOptions, type TerminalTone } from "./terminal";

export interface StatusReport {
  version: string;
  directory: string;
  connection: string;
  server: string;
  project?: string;
  // null means inspection was blocked; [] means Docker confirmed no containers.
  services: readonly ServiceState[] | null;
  expected: readonly string[];
  health:
    | (Pick<HealthResult, "ok" | "detail" | "inference" | "connectionFailed" | "components"> & {
        url?: string;
      })
    | null;
  issue?: { label: string; detail: string; diagnostic?: string; notInstalled?: boolean };
  serverConflict?: boolean;
  next: string;
  nextDetail?: string;
}

export const isSetupJob = (service: ServiceState): boolean =>
  service.Service === "migrate" || service.Service.endsWith("-init");

const failed = (service: ServiceState): boolean =>
  ["restarting", "dead", "paused", "removing"].includes(service.State) ||
  service.Health === "unhealthy" ||
  (service.State === "exited" && service.ExitCode !== undefined && service.ExitCode !== 0);

export const statusState = (
  input: StatusReport
): "NOT INSTALLED" | "STATUS UNKNOWN" | "NEEDS ATTENTION" | "STOPPED" | "STARTING" | "RUNNING" => {
  if (input.issue?.notInstalled) return "NOT INSTALLED";
  if (input.issue || input.services === null) return "STATUS UNKNOWN";
  if (input.serverConflict) return "NEEDS ATTENTION";
  const required = input.services.filter(
    (s) => input.expected.includes(s.Service) || isSetupJob(s)
  );
  if (required.some(failed)) return "NEEDS ATTENTION";
  const containers = required.filter((s) => input.expected.includes(s.Service));
  if (!containers.some((s) => !["exited", "created"].includes(s.State))) return "STOPPED";
  const complete = input.expected.every((name) => containers.some((s) => s.Service === name));
  const transitioning = required.some(
    (s) =>
      s.Health === "starting" || s.State === "created" || (isSetupJob(s) && s.State === "running")
  );
  if (
    complete &&
    transitioning &&
    required.every(
      (s) =>
        ["created", "running"].includes(s.State) ||
        (isSetupJob(s) && s.State === "exited" && s.ExitCode === 0)
    )
  )
    return "STARTING";
  const ready =
    complete &&
    containers.every((s) => s.State === "running" && (!s.Health || s.Health === "healthy")) &&
    required.filter(isSetupJob).every((s) => s.State === "exited" && s.ExitCode === 0) &&
    input.health?.ok;
  return ready ? "RUNNING" : "NEEDS ATTENTION";
};

const serviceDescription = (
  service: ServiceState
): { text: string; tone: TerminalTone; mark: string } => {
  if (isSetupJob(service) && service.State === "exited" && service.ExitCode === 0)
    return { text: "Completed · exit 0", tone: "muted", mark: "✓" };
  const state =
    (
      {
        running: "Running",
        exited: "Stopped",
        created: "Created; not started",
        restarting: "Restarting",
        paused: "Paused",
        dead: "Dead",
        removing: "Being removed",
      } as Record<string, string>
    )[service.State] || `Unknown state: ${service.State || "not reported"}`;
  const detail =
    service.State === "running"
      ? isSetupJob(service)
        ? "setup in progress"
        : service.Health === "healthy"
          ? "healthy"
          : service.Health === "starting"
            ? "health check starting"
            : service.Health === "unhealthy"
              ? "health check failing"
              : !service.Health
                ? "no Docker health check"
                : `health: ${service.Health}`
      : service.State === "exited" || service.State === "dead" || service.State === "restarting"
        ? service.ExitCode === undefined
          ? "exit code not reported"
          : `exit ${service.ExitCode}`
        : "";
  const ok =
    service.State === "running" &&
    !isSetupJob(service) &&
    (!service.Health || service.Health === "healthy");
  return {
    text: `${state}${detail ? ` · ${detail}` : ""}`,
    tone: failed(service) ? "error" : ok ? "success" : "warning",
    mark: failed(service) ? "✗" : ok ? "✓" : "!",
  };
};

export const renderStatus = (input: StatusReport, options: TerminalOptions = {}): string => {
  const state = statusState(input);
  const ready = state === "RUNNING";
  const view = new TerminalReport(options).header(
    "status",
    state,
    ready ? "success" : state === "NEEDS ATTENTION" ? "error" : "warning"
  );
  const containers = input.services?.filter((s) => input.expected.includes(s.Service));
  const summary = input.issue
    ? input.issue.detail
    : containers
      ? `${containers.filter((s) => s.State === "running").length}/${containers.length + input.expected.filter((name) => !containers.some((s) => s.Service === name)).length} containers running · ${containers.filter((s) => s.State === "running" && s.Health === "healthy").length} passing Docker health checks`
      : "Container state could not be checked.";
  view.lines.push("");
  view.text(summary, ready ? "success" : "warning");
  const next = () =>
    view
      .section(ready ? "Next" : "Next steps")
      .text(input.nextDetail || (ready ? "For a deeper check:" : "Recommended action:"))
      .text(input.next, "info");
  if (!ready) next();
  if (input.issue) {
    view
      .section("Check blocked")
      .row(input.issue.label, input.issue.detail, { mark: "✗", tone: "error" });
    if (input.issue.diagnostic) view.text(input.issue.diagnostic);
  }
  view.section("Containers");
  if (input.services === null)
    view.text("Not checked. Resolve the issue above, then run status again.");
  else {
    for (const name of input.expected) {
      const instances = input.services.filter((s) => s.Service === name);
      if (!instances.length) view.row(name, "Not created", { mark: "!", tone: "warning" });
      instances.forEach((service, index) => {
        const { text, ...style } = serviceDescription(service);
        view.row(
          instances.length > 1 ? `${name} (${index + 1}/${instances.length})` : name,
          text,
          style
        );
      });
    }
    const jobs = input.services.filter(isSetupJob);
    if (jobs.length) {
      view.section("Setup jobs");
      for (const job of jobs) {
        const { text, ...style } = serviceDescription(job);
        view.row(job.Service, text, style);
      }
      view.text("Setup jobs finish and stop normally; exit 0 means success.");
    }
  }
  view
    .section("Readiness")
    .row(
      "Server",
      input.health
        ? input.health.ok
          ? "Ready · responding with the installed release"
          : input.health.connectionFailed
            ? `Cannot reach the server: ${input.health.detail}`
            : input.health.detail
        : "Not checked",
      {
        mark: input.health ? (input.health.ok ? "✓" : "✗") : "–",
        tone: input.health ? (input.health.ok ? "success" : "error") : "muted",
      }
    );
  if (input.health?.url) view.row("Checked at", input.health.url);
  for (const [name, value] of Object.entries(input.health?.components ?? {}))
    view.row(
      name === "queue" ? "Queue database" : name === "database" ? "Database" : "Computer API",
      value === "ready" ? "Ready" : value,
      {
        mark: value === "ready" ? "✓" : "✗",
        tone: value === "ready" ? "success" : "error",
      }
    );
  if (input.health?.ok)
    view.row(
      "AI credentials",
      input.health.inference === "ready"
        ? "Configured · model request not tested"
        : input.health.inference
          ? `Not ready (${input.health.inference}) · check provider setup`
          : "Not reported · run doctor to check provider setup",
      { tone: input.health.inference === "ready" ? "muted" : "warning" }
    );
  view
    .section("Connection")
    .row("Server", input.server, { tone: "info" })
    .row("Access", input.connection)
    .row("Version", input.version);
  if (input.project) view.row("Compose project", input.project);
  view.row("Installation", input.directory);
  if (ready) next();
  view.lines.push("");
  return view.toString();
};
