import { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  PluginCatalogItemView,
  PluginConnectionView,
  PluginSettingsView,
} from "@openteam/contracts";
import "../../src/renderer/styles.css";
import github from "../../../../packages/plugins/github/plugin.json";
import slack from "../../../../packages/plugins/slack/plugin.json";
import notion from "../../../../packages/plugins/notion/plugin.json";
import linear from "../../../../packages/plugins/linear/plugin.json";
import gmail from "../../../../packages/plugins/gmail/plugin.json";
import calendar from "../../../../packages/plugins/google-calendar/plugin.json";
import drive from "../../../../packages/plugins/google-drive/plugin.json";
import granola from "../../../../packages/plugins/granola/plugin.json";
import onePassword from "../../../../packages/plugins/1password/plugin.json";
import { createPluginTemplate, type PluginDefinition } from "@openteam/plugin-sdk";
const packagedIcons = import.meta.glob("../../../../packages/plugins/*/assets/icon.png", {
  eager: true,
  query: "?inline",
  import: "default",
}) as Record<string, string>;

// Local synthetic data only. Shipping components and CSS are unmodified.
// Install transport isolation before importing any desktop application modules.
if (window.openteam) throw new Error("Open this fixture in a browser, not Electron.");
window.fetch = async () => {
  throw new Error("Network disabled in plugin capture fixture.");
};
window.open = () => null;
if (new URLSearchParams(location.search).get("clipboard") === "denied") {
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async () => {
        throw new Error("Fixture clipboard unavailable");
      },
    },
  });
}
const [{ api }, { PluginDialog }, { TooltipProvider }] = await Promise.all([
  import("../../src/renderer/client/openteam-api"),
  import("../../src/renderer/components/openteam/plugin-settings"),
  import("../../src/renderer/components/ui/tooltip"),
]);
for (const key of Object.keys(api)) {
  if (typeof api[key as keyof typeof api] === "function") {
    (api as unknown as Record<string, unknown>)[key] = async () => {
      throw new Error(`Fixture does not implement ${key}. No server is connected.`);
    };
  }
}
const timestamp = "2026-09-12T12:00:00.000Z";
const definitions = [
  onePassword,
  gmail,
  calendar,
  drive,
  granola,
  notion,
  slack,
  linear,
  github,
];
const catalog = definitions.map((entry) => ({
  ...entry,
  installed: entry.key === "gmail" || entry.key === "github",
  homepageUrl: "homepageUrl" in entry ? entry.homepageUrl : null,
  sourceUrl: null,
  sourceRevision: null,
  logoUrl: packagedIcons[`../../../../packages/plugins/${entry.key}/assets/icon.png`] ?? null,
  setupFields: [],
  setup: "setup" in entry ? entry.setup : null,
  connections: entry.connections.map((c) => ({ ...c, tools: [] })),
})) as PluginCatalogItemView[];
if (new URLSearchParams(location.search).get("icons") === "broken")
  catalog[0]!.logoUrl = "data:image/png;base64,broken";
const githubCatalog = catalog.find((p) => p.key === "github")!;
const gmailCatalog = catalog.find((p) => p.key === "gmail")!;
const connection: PluginConnectionView = {
  id: "sample-github-work",
  revision: "1",
  pluginKey: "github",
  connectorKey: "github",
  name: "GitHub",
  alias: "work",
  transport: "http",
  auth: "token",
  status: "ready",
  statusMessage: null,
  instructions: "",
  authorizationUrl: null,
  oauthRedirectUrl: null,
  canAuthenticate: false,
  configured: true,
  command: null,
  // Synthetic configured subset. Names verified against GitHub's official MCP
  // README: https://github.com/github/github-mcp-server . No tools are called.
  tools: [
    {
      name: "search_repositories",
      description: "Search repositories.",
      risk: "read",
      defaultDecision: "allow",
    },
    {
      name: "pull_request_read",
      description: "Read pull requests and diffs.",
      risk: "read",
      defaultDecision: "allow",
    },
    {
      name: "issue_write",
      description: "Create or update an issue.",
      risk: "write",
      defaultDecision: "prompt",
    },
  ],
};
const settings: PluginSettingsView = {
  catalog,
  installs: [
    {
      catalog: githubCatalog,
      id: "sample-install-github",
      pluginKey: "github",
      version: github.version,
      name: github.name,
      description: github.description,
      publisher: github.publisher,
      status: "installed",
      installedAt: timestamp,
      hasSkills: false,
      connections: [connection],
    },
    {
      catalog: gmailCatalog,
      id: "sample-install-gmail",
      pluginKey: "gmail",
      version: gmail.version,
      name: gmail.name,
      description: gmail.description,
      publisher: gmail.publisher,
      status: "installed",
      installedAt: timestamp,
      hasSkills: false,
      connections: [
        {
          ...connection,
          id: "sample-gmail-personal",
          pluginKey: "gmail",
          connectorKey: "gmail",
          name: "Gmail",
          alias: "personal",
          auth: "oauth",
          transport: "stdio",
          tools: [],
        },
        {
          ...connection,
          id: "sample-gmail-work",
          pluginKey: "gmail",
          connectorKey: "gmail",
          name: "Gmail",
          alias: "work",
          auth: "oauth",
          transport: "stdio",
          status: "needs_auth",
          configured: true,
          canAuthenticate: true,
          tools: [],
        },
      ],
    },
  ],
  botCount: 3,
  policies: connection.tools.map((tool) => ({
    id: `sample-policy-${tool.name}`,
    connectionId: connection.id,
    botId: null,
    toolName: tool.name,
    decision: tool.defaultDecision,
  })),
  activity: [],
};
const bots = [
  { id: "sample-research", name: "Research", icon: "helmet", color: "orange" },
  { id: "sample-operations", name: "Operations", icon: "pod", color: "purple" },
  { id: "sample-engineering", name: "Engineering", icon: "chip", color: "teal" },
];
const skill = {
  id: "sample-private-research",
  name: "Vendor research",
  description: "Compare vendors against our requirements and budget.",
  body: "Read the brief before researching.\nUse primary sources for pricing and SSO support.\nRecord the source URL and the date checked for each claim.\nCompare each vendor against the requirements and budget.\nSave a recommendation with tradeoffs and unresolved questions.",
  files: {},
  enabledBotIds: ["sample-research"],
};
const draftDefinition = createPluginTemplate("skills", "sample-review");
const management = {
  sources: [],
  drafts: [
    {
      id: "sample-draft",
      name: draftDefinition.name,
      definition: draftDefinition,
      format: "openteam" as const,
      warnings: [],
      digest: "fixture",
      sourceUrl: null,
      updatedAt: timestamp,
    },
  ],
  skills: [skill],
};
api.pluginSettings = async () => structuredClone(settings);
api.installPlugin = async (key) => {
  const plugin = settings.catalog.find((item) => item.key === key)!;
  plugin.installed = true;
  settings.installs.push({
    catalog: plugin, id: `sample-install-${key}`, pluginKey: key, version: plugin.version,
    name: plugin.name, description: plugin.description, publisher: plugin.publisher,
    status: "installed", installedAt: timestamp, hasSkills: plugin.skills.length > 0,
    connections: plugin.connections.map((connector) => ({
      ...connection, id: `sample-${key}-default`, pluginKey: key, connectorKey: connector.key,
      name: connector.name, alias: "default", transport: connector.transport, auth: connector.auth,
      status: "disconnected", statusMessage: null, configured: connector.auth === "none",
      canAuthenticate: connector.auth === "oauth", tools: [],
    })),
  });
  return { id: `sample-install-${key}`, status: "installed" };
};
api.connectPlugin = async (id) => {
  const account = findAccount(id);
  if (account.pluginKey !== "1password") throw new Error("This fixture only simulates native 1Password connection failures.");
  account.status = "error";
  account.statusMessage = "Unlock 1Password, enable Integrate with MCP clients in Settings → Developer, complete any macOS setup prompt, then retry and approve the connection.";
  throw new Error(account.statusMessage);
};
api.uninstallPlugin = async (key) => {
  settings.installs = settings.installs.filter((install) => install.pluginKey !== key);
  const plugin = settings.catalog.find((item) => item.key === key);
  if (plugin) plugin.installed = false;
};
api.pluginManagement = async () => structuredClone(management);
api.pluginBotAccess = async () => ({
  pluginKey: "github",
  offset: 0,
  limit: 60,
  total: 3,
  bots: bots.map((bot) => ({
    ...bot,
    enabled: bot.name === "Engineering",
    skillsEnabled: false,
    grantedConnectionIds: bot.name === "Engineering" ? [connection.id] : [],
  })),
});
api.bots = async () => bots as Awaited<ReturnType<typeof api.bots>>;
api.pluginPackage = async (key) => ({
  definition: structuredClone(definitions.find((p) => p.key === key) as PluginDefinition),
  digest: "fixture",
  mode: "optional",
  skillSyncStatus: "ready",
  skillSyncError: null,
  hasRollback: false,
  update: null,
});
const findAccount = (id: string) =>
  settings.installs.flatMap((p) => p.connections).find((c) => c.id === id)!;
// These operations mutate only the synthetic in-memory fixture. They cannot reach a provider.
api.renamePluginAccount = async (id, alias) => {
  findAccount(id).alias = alias;
};
api.removePluginAccount = async (id) => {
  for (const install of settings.installs) {
    install.connections = install.connections.filter((account) => account.id !== id);
  }
};
api.addPluginAccount = async (id, alias) => {
  const source = findAccount(id);
  const install = settings.installs.find((p) => p.pluginKey === source.pluginKey)!;
  if (install.connections.some((c) => c.alias === alias))
    throw new Error("An account with that name already exists.");
  install.connections.push({
    ...source,
    id: `sample-added-${alias}`,
    alias,
    status: "needs_auth",
    configured: false,
    tools: [],
  });
};
api.authenticatePlugin = async (id) => {
  findAccount(id).status = "ready";
  return { authorizationUrl: "https://example.invalid/fixture-only", status: "ready" };
};
api.restartPluginConnection = async (id) => {
  findAccount(id).status = "ready";
};
api.pluginConfiguration = async (id) => {
  const account = findAccount(id);
  const definition = definitions.find((p) => p.key === account.pluginKey)! as PluginDefinition;
  return {
    connectionId: id,
    namespace: `${account.pluginKey}_${account.alias.replaceAll(" ", "_")}`,
    endpoint: definition.connections[0]!.endpoint,
    command: null,
    runtime: account.pluginKey === "1password" ? "desktop" : "computer",
    args: [],
    cwd: null,
    values: {},
    fields: definition.setup?.fields ?? [],
    configuredSecrets: account.configured
      ? [account.auth === "oauth" ? "clientSecret" : "token"]
      : [],
    headerNames: [],
    environmentNames: [],
    setup: definition.setup ?? null,
    callbackUrl:
      account.auth === "oauth" ? `http://localhost:5199/fixture/callback?connectionId=${id}` : "",
    tokenEndpointAuthMethod: "none",
  };
};
function Reference() {
  const [open, setOpen] = useState(true);
  return (
    <TooltipProvider>
      <button type="button" onClick={() => setOpen(true)}>
        Open plugins
      </button>
      <PluginDialog open={open} onOpenChange={setOpen} />
    </TooltipProvider>
  );
}
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") ?? "light";
const root = createRoot(document.getElementById("root")!);
import.meta.hot?.dispose(() => root.unmount());
root.render(<Reference />);
