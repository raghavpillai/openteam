import type { InstallationPaths } from "./config";
import { defaultInstallDirectory } from "./config";
import type { ProviderRow, ModelRow } from "./providers";
export { renderStatus } from "./status-ui";
import type { PersistedUpdateState } from "./update-safety";
import { TerminalReport, type TerminalOptions, type TerminalTone } from "./terminal";

export const installationCommand = (paths: InstallationPaths, command: string): string =>
  `openteam ${command}${paths.directory === defaultInstallDirectory() ? "" : ` --dir '${paths.directory.replace(/'/g, process.platform === "win32" ? "''" : "'\\''")}'`}`;

export const renderSummary = (
  command: string,
  status: string,
  rows: readonly { label: string; value: string }[],
  notes: readonly { text: string; tone?: TerminalTone }[] = [],
  options: TerminalOptions = {}
): string => {
  const view = new TerminalReport(options).header(command, status, "success");
  view.lines.push("");
  for (const row of rows) view.row(row.label, row.value);
  if (notes.length) {
    view.lines.push("");
    for (const note of notes) view.notice(note.text, note.tone);
  }
  view.lines.push("");
  return view.toString();
};

export const renderProviderCatalog = (
  providers: readonly ProviderRow[],
  selected: string,
  paths: InstallationPaths,
  options: TerminalOptions = {}
): string => {
  const connected = providers.filter((p) => p.configured);
  const view = new TerminalReport(options).header(
    "providers",
    `${connected.length} connected · ${providers.length} providers`
  );
  for (const [title, rows] of [
    ["Connected accounts", connected],
    ["Available to connect", providers.filter((p) => !p.configured)],
  ] as const) {
    if (!rows.length) continue;
    view.section(title);
    for (const provider of [...rows].sort(
      (a, b) => Number(b.id === selected) - Number(a.id === selected)
    )) {
      const active = provider.id === selected;
      const method =
        provider.authType === "oauth"
          ? "OAuth"
          : provider.authType === "api_key"
            ? "API key"
            : "Configured credentials";
      const auth = provider.configured
        ? `Connected · ${method}`
        : provider.authMethods
            .map((m) => m.label.replace(/\bBearer token\b/gi, "token"))
            .join(" / ") || "Ambient credentials";
      view.row(
        provider.id,
        `${provider.name} · ${provider.models} chat models · ${auth}${provider.custom ? " · custom" : ""}${active ? " · selected" : ""}`,
        {
          mark: active ? "●" : provider.configured ? "✓" : "·",
          tone: provider.configured ? "success" : "muted",
          active,
          labelWidth: 28,
        }
      );
      if (provider.modelMessage)
        view.notice(
          provider.modelMessage,
          provider.modelStatus === "unavailable" ? "warning" : "muted"
        );
    }
  }
  if (!providers.length) view.notice("No providers are available.", "warning");
  else if (!connected.length)
    view.notice("Connect a provider before starting AI tasks.", "warning");
  view
    .section("Next")
    .text(installationCommand(paths, "provider login <provider>"), "info")
    .text(installationCommand(paths, "model list <provider>"), "info");
  view.lines.push("");
  return view.toString();
};

export const renderModelCatalog = (
  models: readonly ModelRow[],
  selected: { providerId: string; modelId: string; reasoning: string },
  paths: InstallationPaths,
  providerId?: string,
  options: TerminalOptions = {},
  registry: readonly ProviderRow[] = []
): string => {
  const activeModel = `${selected.providerId}/${selected.modelId}`;
  const view = new TerminalReport(options).header(
    "models",
    `${models.length} accessible chat models${providerId ? ` · ${providerId}` : ""}`
  );
  view.lines.push("");
  view.row("Selected", activeModel, { mark: "●", tone: "info", active: true });
  view.row("Thinking", selected.reasoning);
  const providers = [...new Set(models.map((m) => m.providerId))].sort(
    (a, b) =>
      Number(b === selected.providerId) - Number(a === selected.providerId) || a.localeCompare(b)
  );
  for (const provider of providers) {
    const group = models.filter((m) => m.providerId === provider);
    const labelWidth = Math.min(
      44,
      group.reduce((width, model) => Math.max(width, `${provider}/${model.modelId}`.length), 0)
    );
    view.section(`${provider} · ${group.length} models`);
    for (const model of [...group].sort(
      (a, b) => Number(b.modelId === selected.modelId) - Number(a.modelId === selected.modelId)
    )) {
      const active = provider === selected.providerId && model.modelId === selected.modelId;
      const capabilities = [
        model.reasoning ? "reasoning" : "",
        model.input.includes("image") ? "images" : "",
      ].filter(Boolean);
      view.row(
        `${provider}/${model.modelId}`,
        `${model.contextWindow.toLocaleString("en-US")} context${capabilities.length ? ` · ${capabilities.join(" · ")}` : ""}${active ? " · selected" : ""}`,
        {
          mark: active ? "●" : "·",
          active,
          tone: active ? "info" : "muted",
          labelWidth,
        }
      );
    }
  }
  for (const provider of registry.filter(
    (p) => (!providerId || p.id === providerId) && p.modelStatus === "unavailable"
  ))
    view.notice(
      `${provider.name}: ${provider.modelMessage ?? "Model discovery is unavailable. Reconnect the provider and retry."}`,
      "warning"
    );
  if (!models.length)
    view.notice(
      `No models found${providerId ? ` for ${providerId}` : ""}. Connect a provider or check model discovery.`,
      "warning"
    );
  view.text(installationCommand(paths, "provider list"), "info");
  view
    .section("Switch model")
    .text(installationCommand(paths, `model use ${providerId || "<provider>"} <model>`), "info")
    .text("Add --thinking medium to choose a thinking level.");
  view.lines.push("");
  return view.toString();
};

export const renderUpdateEvent = (
  state: PersistedUpdateState,
  options: TerminalOptions = {}
): string => {
  const labels = {
    checking: "CHECK",
    downloading: "DOWNLOAD",
    "backing-up": "BACKUP",
    pulling: "IMAGES",
    restarting: "RESTART",
    verifying: "VERIFY",
    "updating-cli": "CLI",
    "rolling-back": "ROLLBACK",
    complete: "COMPLETE",
    error: "FAILED",
  };
  const tone =
    state.status === "error"
      ? "error"
      : state.status === "complete"
        ? "success"
        : state.phase === "rolling-back"
          ? "warning"
          : "info";
  return new TerminalReport(options)
    .row(labels[state.phase] || state.phase, state.message, {
      mark: state.status === "complete" ? "✓" : state.status === "error" ? "✗" : "◇",
      tone,
      labelWidth: 10,
    })
    .toString();
};

export const renderHelp = (source: string, options: TerminalOptions = {}): string => {
  const lines = source.split("\n");
  const version = lines[0]?.match(/^OpenTeam (.+)$/)?.[1];
  const view = new TerminalReport(options).header(
    "help",
    version ? `VERSION ${version}` : undefined,
    "muted"
  );
  for (const line of version ? lines.slice(1) : lines) {
    if (!line.trim()) {
      if (view.lines.at(-1) !== "") view.lines.push("");
      continue;
    }
    const row = line.match(/^\s{2}(\S.*?)\s{2,}(\S.*)$/);
    if (row)
      view.row(row[1]!, row[2]!, { labelWidth: row[1]!.startsWith("--") ? 25 : 15, active: true });
    else if (/^[^\s].*:$/.test(line)) view.section(line.slice(0, -1));
    else view.text(line.trim(), line.trim().startsWith("openteam ") ? "info" : "muted");
  }
  view.lines.push("");
  return view.toString();
};

export const renderCommandError = (message: string, options: TerminalOptions = {}): string => {
  const view = new TerminalReport(options).header("error", "COMMAND FAILED", "error");
  view.lines.push("");
  view.notice(message, "error");
  view.lines.push("");
  return view.toString();
};
