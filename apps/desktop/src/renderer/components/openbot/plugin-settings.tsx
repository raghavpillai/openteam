import type {
  PluginBotAccessItemView,
  PluginBotAccessView,
  PluginCatalogItemView,
  PluginConnectionView,
  PluginInstallView,
  PluginSettingsView,
} from "@openbot/contracts";
import {
  executePluginAccessTransition,
  planPluginConnectionGrant,
  planPluginSkillAccess,
} from "@openbot/product-core/plugin-access";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Plus,
  Search,
  X,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../client/openbot-api";
import { cn } from "../../lib/cn";
import {
  createCoalescedRefresh,
  mergePluginConnectionStatuses,
  PLUGIN_BOT_ACCESS_PAGE_SIZE,
  PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH,
  pluginBotAccessWindow,
} from "../../lib/plugin-settings-scale";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

const loadPluginSettingsDetail = () => import("./plugin-settings-detail");
const PluginPolicySelect = lazy(() =>
  loadPluginSettingsDetail().then((module) => ({ default: module.PluginPolicySelect }))
);
const PluginAuthSelect = lazy(() =>
  loadPluginSettingsDetail().then((module) => ({ default: module.PluginAuthSelect }))
);

type MarketplacePage = "marketplace" | "installed" | "detail" | "custom";

const marketplaceCategories = [
  "All",
  "Featured",
  "Team plugins",
  "Agent Orchestration",
  "Canvas",
  "Customer Support",
  "Data Analytics",
  "Design",
  "Documents And Files",
  "Finance And Legal",
  "Inbox And Collaboration",
  "Infrastructure",
  "MCP",
  "Payments",
  "Productivity",
  "Research",
  "Sales",
  "Scheduling",
] as const;

const categoryAliases: Record<string, string> = {
  "Documents And Files": "Documents & Files",
};

const primaryButton =
  "inline-flex h-[26px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-black px-3 text-[13px] font-medium text-white outline-none transition-opacity hover:opacity-80 disabled:cursor-wait disabled:opacity-45 dark:bg-white dark:text-black";
const secondaryButton =
  "inline-flex h-[26px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-black/[0.055] px-3 text-[13px] text-foreground outline-none transition-colors hover:bg-black/[0.09] disabled:cursor-wait disabled:opacity-45 dark:bg-[#222222] dark:hover:bg-[#2b2b2b]";

const errorMessage = (cause: unknown) => clientErrorMessage(cause, "Plugin operation failed");

function PluginMark({
  logoUrl,
  name,
  size = "md",
}: {
  logoUrl?: string | null;
  name: string;
  size?: "sm" | "md" | "lg";
}) {
  const google = name.startsWith("Google") || name === "Gmail";
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-[11px] bg-black/[0.055] font-medium dark:bg-[#373737]",
        size === "sm" && "size-8 text-[12px]",
        size === "md" && "size-10 text-[14px]",
        size === "lg" && "size-12 rounded-[13px] text-[16px]"
      )}
    >
      <span
        className={cn(google && "font-bold")}
        style={
          google
            ? {
                background:
                  "conic-gradient(from -45deg,#4285f4 0 25%,#34a853 0 43%,#fbbc05 0 68%,#ea4335 0 84%,#4285f4 0)",
                backgroundClip: "text",
                color: "transparent",
              }
            : undefined
        }
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
      {logoUrl ? (
        <img
          alt=""
          className="absolute size-[72%] bg-inherit object-contain"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
          src={logoUrl}
        />
      ) : null}
    </span>
  );
}

function SearchField({ query, onChange }: { query: string; onChange: (value: string) => void }) {
  return (
    <label className="relative block">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-[14px] -translate-y-1/2 text-foreground-tertiary"
        strokeWidth={2}
      />
      <input
        aria-label="Search plugins"
        className="h-8 w-full rounded-[8px] border-[0.5px] border-black/[0.055] bg-black/[0.045] pl-[31px] pr-3 text-[14px] outline-none placeholder:text-foreground-tertiary focus:border-black/10 dark:border-white/[0.07] dark:bg-[#292929]"
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search plugins"
        value={query}
      />
    </label>
  );
}

function InstallAction({
  busy,
  plugin,
  onInstall,
}: {
  busy: string | null;
  plugin: PluginCatalogItemView;
  onInstall: (plugin: PluginCatalogItemView) => void;
}) {
  if (plugin.installed) {
    return (
      <span className="inline-flex h-[26px] shrink-0 items-center gap-1 px-1 text-[13px] text-[#00a86b]">
        <Check className="size-3.5" strokeWidth={2.2} /> Added
      </span>
    );
  }
  return (
    <button
      className={secondaryButton}
      disabled={busy === plugin.key}
      onClick={(event) => {
        event.stopPropagation();
        onInstall(plugin);
      }}
      type="button"
    >
      {busy === plugin.key ? <LoaderCircle className="size-3 animate-spin" /> : null}
      Add
    </button>
  );
}

function CompactPluginRow({
  busy,
  plugin,
  onInstall,
  onOpen,
}: {
  busy: string | null;
  plugin: PluginCatalogItemView;
  onInstall: (plugin: PluginCatalogItemView) => void;
  onOpen: (plugin: PluginCatalogItemView) => void;
}) {
  return (
    <div className="group flex min-w-0 items-center rounded-[9px] px-2 transition-colors hover:bg-black/[0.025] focus-within:bg-black/[0.04] dark:hover:bg-white/[0.035]">
      <button
        className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left outline-none"
        onClick={() => onOpen(plugin)}
        type="button"
      >
        <PluginMark logoUrl={plugin.logoUrl} name={plugin.name} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[13px] font-medium leading-[18px]">
            <span className="truncate">{plugin.name}</span>
            {plugin.featured ? (
              <span className="rounded-full bg-black/[0.055] px-1.5 py-0.5 text-[8px] font-normal uppercase tracking-[0.04em] text-foreground-tertiary dark:bg-white/[0.08]">
                Featured
              </span>
            ) : null}
          </span>
          <span className="block truncate text-[13px] leading-[18px] text-foreground-secondary">
            {plugin.description}
          </span>
        </span>
      </button>
      <InstallAction busy={busy} onInstall={onInstall} plugin={plugin} />
    </div>
  );
}

function FilteredPluginRow({
  busy,
  plugin,
  onInstall,
  onOpen,
}: {
  busy: string | null;
  plugin: PluginCatalogItemView;
  onInstall: (plugin: PluginCatalogItemView) => void;
  onOpen: (plugin: PluginCatalogItemView) => void;
}) {
  return (
    <div className="group flex w-full items-center rounded-[10px] px-2 transition-colors hover:bg-black/[0.025] focus-within:bg-black/[0.04] dark:hover:bg-white/[0.035]">
      <button
        className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left outline-none"
        onClick={() => onOpen(plugin)}
        type="button"
      >
        <PluginMark logoUrl={plugin.logoUrl} name={plugin.name} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[13px] font-medium leading-[18px]">
            <span>{plugin.name}</span>
          </span>
          <span className="block truncate text-[13px] leading-[18px] text-foreground-secondary">
            {plugin.description}
          </span>
        </span>
      </button>
      <InstallAction busy={busy} onInstall={onInstall} plugin={plugin} />
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <div className="px-2 text-[13px] leading-[18px] text-foreground-tertiary">{children}</div>;
}

function MarketplaceHome({
  busy,
  data,
  onInstall,
  onOpen,
}: {
  busy: string | null;
  data: PluginSettingsView;
  onInstall: (plugin: PluginCatalogItemView) => void;
  onOpen: (plugin: PluginCatalogItemView) => void;
}) {
  const featured = data.catalog.filter((plugin) => plugin.featured);
  const rest = data.catalog.filter((plugin) => !plugin.featured);
  const groups = [...new Set(rest.map((plugin) => plugin.category))];
  return (
    <div className="space-y-6 pb-8 pt-1">
      {featured.length ? (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <SectionHeading>Featured</SectionHeading>
            <span className="px-2 text-[10.5px] text-foreground-tertiary">View all</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 max-sm:grid-cols-1">
            {featured.map((plugin) => (
              <CompactPluginRow
                busy={busy}
                key={plugin.key}
                onInstall={onInstall}
                onOpen={onOpen}
                plugin={plugin}
              />
            ))}
          </div>
        </section>
      ) : null}
      {groups.map((group) => (
        <section key={group}>
          <div className="mb-2 flex items-center justify-between">
            <SectionHeading>{group}</SectionHeading>
            <span className="px-2 text-[10.5px] text-foreground-tertiary">View all</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 max-sm:grid-cols-1">
            {rest
              .filter((plugin) => plugin.category === group)
              .map((plugin) => (
                <CompactPluginRow
                  busy={busy}
                  key={plugin.key}
                  onInstall={onInstall}
                  onOpen={onOpen}
                  plugin={plugin}
                />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function MarketplaceView({
  busy,
  data,
  onInstall,
  onOpen,
  onShowInstalled,
}: {
  busy: string | null;
  data: PluginSettingsView;
  onInstall: (plugin: PluginCatalogItemView) => void;
  onOpen: (plugin: PluginCatalogItemView) => void;
  onShowInstalled: () => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("All");
  const normalized = query.trim().toLowerCase();
  const categoryValue = categoryAliases[category] ?? category;
  const filtered = data.catalog.filter((plugin) => {
    const categoryMatches =
      category === "All" ||
      (category === "Featured" && plugin.featured) ||
      plugin.category === categoryValue ||
      (category === "MCP" && plugin.components.includes("mcp"));
    return (
      categoryMatches &&
      `${plugin.name} ${plugin.description} ${plugin.publisher}`.toLowerCase().includes(normalized)
    );
  });
  const groupedHome = category === "All" && !normalized;
  return (
    <div className="px-8 pb-5 pt-[14px]">
      {data.installs.length ? (
        <button
          className="mb-3 flex h-8 items-center gap-2 rounded-[8px] px-1 text-left outline-none transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.035]"
          onClick={onShowInstalled}
          type="button"
        >
          <span className="flex -space-x-1">
            {data.installs.slice(0, 3).map((plugin) => (
              <span className="rounded-[7px] ring-2 ring-background" key={plugin.id}>
                <PluginMark name={plugin.name} size="sm" />
              </span>
            ))}
          </span>
          <span className="text-[11.5px] text-foreground-secondary">
            {data.installs.length} installed
          </span>
          <ChevronRight className="size-3.5 text-foreground-tertiary" />
        </button>
      ) : null}
      <SearchField onChange={setQuery} query={query} />
      <div className="mt-3 flex max-h-[94px] flex-wrap gap-2 overflow-y-auto">
        {marketplaceCategories.map((item) => (
          <button
            className={cn(
              "h-[26px] rounded-[6px] border-[0.5px] px-2 text-[13px] leading-[18px] outline-none transition-colors",
              item === category
                ? "border-black/10 bg-black/[0.075] text-foreground dark:border-[#353535] dark:bg-[#282828]"
                : "border-black/[0.07] bg-background text-foreground-secondary hover:bg-black/[0.035] dark:border-white/[0.09] dark:hover:bg-white/[0.05]"
            )}
            key={item}
            onClick={() => setCategory(item)}
            type="button"
          >
            {item}
          </button>
        ))}
      </div>
      <div className="grok-scrollbar mt-6 h-[468px] overflow-y-auto pr-1">
        {groupedHome ? (
          <MarketplaceHome busy={busy} data={data} onInstall={onInstall} onOpen={onOpen} />
        ) : filtered.length ? (
          <section>
            <SectionHeading>{normalized ? "Results" : category}</SectionHeading>
            <div className="mt-2 space-y-0.5">
              {filtered.map((plugin) => (
                <FilteredPluginRow
                  busy={busy}
                  key={plugin.key}
                  onInstall={onInstall}
                  onOpen={onOpen}
                  plugin={plugin}
                />
              ))}
            </div>
          </section>
        ) : (
          <div className="grid h-40 place-items-center text-[11.5px] text-foreground-tertiary">
            No plugins found.
          </div>
        )}
      </div>
    </div>
  );
}

const installFor = (data: PluginSettingsView, pluginKey: string) =>
  data.installs.find((plugin) => plugin.pluginKey === pluginKey);

const catalogPluginForInstall = (install: PluginInstallView): PluginCatalogItemView => ({
  key: install.pluginKey,
  version: install.version,
  name: install.name,
  description: install.description,
  publisher: install.publisher,
  category: "MCP",
  featured: false,
  installed: true,
  components: [
    ...(install.hasSkills ? (["skills"] as const) : []),
    ...(install.connections.length ? (["mcp"] as const) : []),
  ],
  connections: install.connections.map((connection) => ({
    key: connection.connectorKey,
    name: connection.name,
    transport: connection.transport,
    auth: connection.auth,
    tools: connection.tools,
  })),
  skills: [],
  homepageUrl: null,
  sourceUrl: null,
  sourceRevision: null,
  logoUrl: null,
  setupFields: [],
  setup: null,
});

function InstalledRow({
  busy,
  install,
  onOpen,
}: {
  busy: string | null;
  install: PluginInstallView;
  onOpen: () => void;
}) {
  const needsAuth = install.connections.find((connection) => connection.status === "needs_auth");
  return (
    <div className="flex w-full items-center rounded-[10px] px-2 transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.035]">
      <button
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left outline-none"
        onClick={onOpen}
        type="button"
      >
        <PluginMark name={install.name} />
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-medium">{install.name}</span>
          <span className="mt-0.5 block text-[11px] text-foreground-secondary">
            {install.connections.length
              ? `${install.connections.length} connector${install.connections.length === 1 ? "" : "s"}`
              : install.hasSkills
                ? "Plugin skill"
                : "Installed"}
          </span>
        </span>
      </button>
      {needsAuth ? (
        <button
          className={secondaryButton}
          disabled={busy === needsAuth.id}
          onClick={onOpen}
          type="button"
        >
          {busy === needsAuth.id ? <LoaderCircle className="size-3 animate-spin" /> : null}
          Set up
        </button>
      ) : null}
    </div>
  );
}

function InstalledView({
  busy,
  data,
  onCustom,
  onBack,
  onOpen,
}: {
  busy: string | null;
  data: PluginSettingsView;
  onCustom: () => void;
  onBack: () => void;
  onOpen: (plugin: PluginCatalogItemView) => void;
}) {
  const [query, setQuery] = useState("");
  const installs = data.installs.filter((plugin) =>
    `${plugin.name} ${plugin.description}`.toLowerCase().includes(query.trim().toLowerCase())
  );
  return (
    <div className="px-8 pb-6">
      <button
        className="mb-5 inline-flex items-center gap-1 text-[11px] text-foreground-secondary hover:text-foreground"
        onClick={onBack}
        type="button"
      >
        <ChevronLeft className="size-3.5" /> Back to Marketplace
      </button>
      <SearchField onChange={setQuery} query={query} />
      <div className="grok-scrollbar mt-7 h-[514px] overflow-y-auto pr-1">
        <section>
          <SectionHeading>Installed</SectionHeading>
          <div className="mt-2 max-w-[390px] space-y-0.5">
            {installs.length ? (
              installs.map((install) => {
                const plugin =
                  data.catalog.find((candidate) => candidate.key === install.pluginKey) ??
                  catalogPluginForInstall(install);
                return (
                  <InstalledRow
                    busy={busy}
                    install={install}
                    key={install.id}
                    onOpen={() => onOpen(plugin)}
                  />
                );
              })
            ) : (
              <div className="px-2 py-3 text-[11px] text-foreground-tertiary">
                No installed plugins.
              </div>
            )}
          </div>
        </section>
        <section className="mt-8">
          <SectionHeading>Private</SectionHeading>
          <p className="mt-2 px-2 text-[11px] text-foreground-secondary">
            No private skills yet. Ask your Bot to create one for you.
          </p>
          <button
            className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-[11px] text-foreground-secondary hover:bg-black/[0.035] dark:hover:bg-white/[0.05]"
            onClick={onCustom}
            type="button"
          >
            <Plus className="size-3.5" /> Add custom MCP
          </button>
        </section>
      </div>
    </div>
  );
}

function CustomMcpView({
  busy,
  onBack,
  onSubmit,
}: {
  busy: boolean;
  onBack: () => void;
  onSubmit: (input: {
    name: string;
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
    auth: "none" | "token" | "oauth";
    alias: string;
  }) => void;
}) {
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [args, setArgs] = useState("");
  const [configuration, setConfiguration] = useState("");
  const [auth, setAuth] = useState<"none" | "token" | "oauth">("none");
  const [alias, setAlias] = useState("default");
  const field =
    "h-9 w-full rounded-[8px] border border-black/10 bg-black/[0.035] px-3 text-[12px] outline-none focus:border-black/20 dark:border-white/10 dark:bg-[#222] dark:focus:border-white/20";
  const parsedConfiguration = (() => {
    if (!configuration.trim()) return {};
    try {
      const value = JSON.parse(configuration) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const entries = Object.entries(value);
      if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
        return null;
      }
      return Object.fromEntries(entries);
    } catch {
      return null;
    }
  })();
  const valid =
    name.trim().length >= 2 && location.trim().length > 0 && parsedConfiguration !== null;
  return (
    <form
      className="mx-auto w-full max-w-[560px] px-8 pb-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        onSubmit({
          name: name.trim(),
          ...(transport === "http"
            ? { url: location.trim() }
            : {
                command: location.trim(),
                args: args
                  .split(/\s+/)
                  .map((item) => item.trim())
                  .filter(Boolean),
              }),
          ...(transport === "stdio"
            ? { env: parsedConfiguration ?? undefined }
            : { headers: parsedConfiguration ?? undefined }),
          auth,
          alias: alias.trim() || "default",
        });
      }}
    >
      <button
        className="mb-6 inline-flex items-center gap-1 text-[11px] text-foreground-secondary hover:text-foreground"
        onClick={onBack}
        type="button"
      >
        <ChevronLeft className="size-3.5" /> Back to Installed
      </button>
      <div className="mb-6">
        <h2 className="text-[15px] font-medium">Add custom MCP</h2>
        <p className="mt-1 text-[11.5px] leading-5 text-foreground-secondary">
          Remote servers run through OpenBot. Local commands run on the shared bot computer.
        </p>
      </div>
      <div className="space-y-4 rounded-[14px] bg-black/[0.035] p-4 dark:bg-white/[0.055]">
        <label className="block text-[11px] text-foreground-secondary">
          Name
          <input
            className={cn(field, "mt-1.5")}
            onChange={(e) => setName(e.target.value)}
            value={name}
          />
        </label>
        <div>
          <div className="mb-1.5 text-[11px] text-foreground-secondary">Transport</div>
          <div className="inline-flex rounded-[8px] bg-black/[0.06] p-0.5 dark:bg-black/30">
            {(["http", "stdio"] as const).map((value) => (
              <button
                className={cn(
                  "h-7 rounded-[6px] px-3 text-[11px] capitalize",
                  transport === value && "bg-background shadow-sm"
                )}
                key={value}
                onClick={() => setTransport(value)}
                type="button"
              >
                {value === "http" ? "Remote HTTP" : "Local stdio"}
              </button>
            ))}
          </div>
        </div>
        <label className="block text-[11px] text-foreground-secondary">
          {transport === "http" ? "MCP URL" : "Command"}
          <input
            className={cn(field, "mt-1.5 font-mono")}
            onChange={(e) => setLocation(e.target.value)}
            placeholder={transport === "http" ? "https://example.com/mcp" : "npx"}
            value={location}
          />
        </label>
        {transport === "stdio" ? (
          <>
            <label className="block text-[11px] text-foreground-secondary">
              Arguments
              <input
                className={cn(field, "mt-1.5 font-mono")}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-filesystem /workspace"
                value={args}
              />
            </label>
            <label className="block text-[11px] text-foreground-secondary">
              Environment JSON (optional)
              <textarea
                className={cn(field, "mt-1.5 h-20 resize-none py-2 font-mono")}
                onChange={(e) => setConfiguration(e.target.value)}
                placeholder={'{"API_KEY":"value"}'}
                value={configuration}
              />
            </label>
          </>
        ) : (
          <>
            <div className="text-[11px] text-foreground-secondary">
              <span>Authentication</span>
              <Suspense
                fallback={
                  <span
                    aria-hidden="true"
                    className={cn(
                      field,
                      "mt-1.5 flex items-center text-foreground capitalize shadow-none"
                    )}
                  >
                    {auth}
                  </span>
                }
              >
                <PluginAuthSelect
                  className={cn(field, "mt-1.5 text-foreground shadow-none")}
                  onChange={setAuth}
                  value={auth}
                />
              </Suspense>
            </div>
            <label className="block text-[11px] text-foreground-secondary">
              Headers JSON (optional)
              <textarea
                className={cn(field, "mt-1.5 h-20 resize-none py-2 font-mono")}
                onChange={(e) => setConfiguration(e.target.value)}
                placeholder={'{"X-API-Key":"value"}'}
                value={configuration}
              />
            </label>
          </>
        )}
        <label className="block text-[11px] text-foreground-secondary">
          Account label
          <input
            className={cn(field, "mt-1.5")}
            onChange={(e) => setAlias(e.target.value)}
            value={alias}
          />
        </label>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button className={secondaryButton} onClick={onBack} type="button">
          Cancel
        </button>
        <button className={primaryButton} disabled={!valid || busy} type="submit">
          {busy ? <LoaderCircle className="size-3 animate-spin" /> : <Plus className="size-3" />}{" "}
          Add server
        </button>
      </div>
    </form>
  );
}

function DetailBlock({
  children,
  count,
  label,
  onOpenChange,
  open = true,
}: {
  children: React.ReactNode;
  count: number;
  label: string;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
}) {
  const singular =
    label === "Connectors"
      ? "connector"
      : label === "Skills"
        ? "skill"
        : label === "Accounts"
          ? "account"
          : label === "Bot access"
            ? "bot"
            : label === "Tool policies"
              ? "tool"
              : "event";
  return (
    <section className="mt-6">
      <div className="mb-1.5 px-3 text-[10.5px] text-foreground-tertiary">{label}</div>
      <details
        className="group overflow-hidden rounded-[13px] bg-black/[0.045] dark:bg-white/[0.06]"
        onToggle={(event) => onOpenChange?.(event.currentTarget.open)}
        open={open}
      >
        <summary className="flex h-9 cursor-pointer list-none items-center px-3 text-[11.5px] outline-none [&::-webkit-details-marker]:hidden">
          <span className="flex-1">
            {count} {singular}
            {count === 1 ? "" : "s"}
          </span>
          <ChevronDown className="size-3.5 text-foreground-tertiary transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-black/[0.06] dark:border-white/[0.07]">{children}</div>
      </details>
    </section>
  );
}

function SquareToggle({
  busy,
  checked,
  label,
  onClick,
}: {
  busy: boolean;
  checked: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className={cn(
        "grid size-5 place-items-center rounded-[6px] border outline-none transition-colors",
        checked
          ? "border-black bg-black text-white dark:border-white dark:bg-white dark:text-black"
          : "border-black/15 bg-background dark:border-white/20"
      )}
      disabled={busy}
      onClick={onClick}
      type="button"
    >
      {busy ? (
        <LoaderCircle className="size-3 animate-spin" />
      ) : checked ? (
        <Check className="size-3" strokeWidth={2.6} />
      ) : null}
    </button>
  );
}

function PluginSetupCard({
  busy,
  connection,
  plugin,
  onAuthenticate,
  onConfigureOAuth,
  onConfigureToken,
}: {
  busy: boolean;
  connection: PluginConnectionView;
  plugin: PluginCatalogItemView;
  onAuthenticate: () => void;
  onConfigureOAuth: (input: { clientId: string; clientSecret: string; scope: string }) => void;
  onConfigureToken: (token: string) => void;
}) {
  const setup = plugin.setup;
  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  if (!setup) return null;

  const ready = connection.status === "ready";
  const missingRequired = setup.fields.some(
    (field) => field.required && !values[field.key]?.trim()
  );
  const copy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1_500);
  };
  const submit = () => {
    if (setup.kind === "token") {
      onConfigureToken(values.token?.trim() ?? "");
      return;
    }
    if (setup.kind === "oauth_client" && (!connection.configured || Object.keys(values).length)) {
      onConfigureOAuth({
        clientId: values.clientId?.trim() ?? "",
        clientSecret: values.clientSecret ?? "",
        scope: values.scope?.trim() ?? "",
      });
      return;
    }
    onAuthenticate();
  };
  const actionLabel = ready
    ? "Connected"
    : setup.kind === "token"
      ? connection.configured
        ? "Reconnect"
        : "Save token and connect"
      : setup.kind === "oauth_client"
        ? connection.configured
          ? "Authorize account"
          : "Save credentials and continue"
        : "Continue to authorization";

  return (
    <section
      className={cn(
        "mt-5 overflow-hidden rounded-[12px] border",
        ready
          ? "border-emerald-500/20 bg-emerald-500/[0.045]"
          : "border-black/[0.07] bg-black/[0.025] dark:border-white/[0.08] dark:bg-white/[0.035]"
      )}
    >
      <div className="flex items-start gap-3 px-4 py-3.5">
        <span
          className={cn(
            "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full",
            ready
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : "bg-black/[0.06] text-foreground-secondary dark:bg-white/[0.08]"
          )}
        >
          {ready ? (
            <Check className="size-3.5" strokeWidth={2.4} />
          ) : (
            <KeyRound className="size-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[12px] font-medium">
              {ready ? `${plugin.name} is connected` : setup.title}
            </div>
            {setup.documentationUrl ? (
              <a
                className="inline-flex shrink-0 items-center gap-1 text-[10px] text-foreground-tertiary hover:text-foreground"
                href={setup.documentationUrl}
                rel="noreferrer"
                target="_blank"
              >
                Setup guide <ExternalLink className="size-2.5" />
              </a>
            ) : null}
          </div>
          <p className="mt-0.5 text-[10.5px] leading-4 text-foreground-secondary">
            {ready
              ? `${connection.tools.length} tools are available from this account.`
              : setup.description}
          </p>
        </div>
      </div>

      {!ready ? (
        <div className="border-t border-black/[0.055] px-4 py-4 dark:border-white/[0.07]">
          {setup.steps.length ? (
            <ol className="grid gap-2.5">
              {setup.steps.map((step, index) => (
                <li
                  className="flex gap-2.5 text-[10.5px] leading-4 text-foreground-secondary"
                  key={step}
                >
                  <span className="grid size-[18px] shrink-0 place-items-center rounded-full border border-black/10 text-[9px] font-medium text-foreground dark:border-white/15">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          ) : null}

          {setup.kind === "oauth_client" && connection.oauthRedirectUrl ? (
            <div className="mt-3 rounded-[8px] border border-black/[0.06] bg-background px-3 py-2.5 dark:border-white/[0.08] dark:bg-black/15">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[9.5px] font-medium uppercase tracking-[0.04em] text-foreground-tertiary">
                  Authorized redirect URI
                </span>
                <button
                  className="inline-flex items-center gap-1 text-[9.5px] text-foreground-secondary hover:text-foreground"
                  onClick={() => void copy("callback", connection.oauthRedirectUrl ?? "")}
                  type="button"
                >
                  {copied === "callback" ? (
                    <Check className="size-3" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                  {copied === "callback" ? "Copied" : "Copy"}
                </button>
              </div>
              <code className="mt-1 block select-all break-all text-[10px] text-foreground">
                {connection.oauthRedirectUrl}
              </code>
            </div>
          ) : null}

          {setup.requiredScopes.length ? (
            <details className="mt-3 text-[10px] text-foreground-secondary">
              <summary className="cursor-pointer select-none text-foreground-secondary">
                Required provider scopes ({setup.requiredScopes.length})
              </summary>
              <div className="mt-2 flex items-start gap-2 rounded-[8px] bg-black/[0.025] p-2.5 dark:bg-black/15">
                <code className="min-w-0 flex-1 whitespace-pre-wrap break-all leading-4">
                  {setup.requiredScopes.join("\n")}
                </code>
                <button
                  aria-label="Copy required scopes"
                  className="grid size-6 shrink-0 place-items-center rounded-[6px] hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                  onClick={() => void copy("scopes", setup.requiredScopes.join(" "))}
                  type="button"
                >
                  {copied === "scopes" ? <Check className="size-3" /> : <Copy className="size-3" />}
                </button>
              </div>
            </details>
          ) : null}

          {setup.fields.length && !connection.configured ? (
            <div className="mt-3 grid grid-cols-2 gap-2 max-sm:grid-cols-1">
              {setup.fields.map((field) => (
                <label className="space-y-1" key={field.key}>
                  <span className="block text-[10px] font-medium text-foreground-secondary">
                    {field.label}
                  </span>
                  <input
                    aria-label={field.label}
                    className="h-8 w-full rounded-[7px] border border-black/[0.08] bg-background px-2.5 text-[10.5px] outline-none placeholder:text-foreground-tertiary focus:border-black/20 dark:border-white/10 dark:bg-[#1d1d1d] dark:focus:border-white/20"
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                    placeholder={field.placeholder}
                    type={field.secret ? "password" : "text"}
                    value={values[field.key] ?? ""}
                  />
                  {field.helpText ? (
                    <span className="block text-[9.5px] leading-3.5 text-foreground-tertiary">
                      {field.helpText}
                    </span>
                  ) : null}
                </label>
              ))}
            </div>
          ) : connection.configured && setup.fields.length ? (
            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[10px] text-emerald-700 dark:text-emerald-400">
              <Check className="size-3" /> Credentials saved
            </div>
          ) : null}

          {connection.statusMessage ? (
            <p className="mt-3 text-[10px] leading-4 text-foreground-tertiary">
              {connection.statusMessage}
            </p>
          ) : null}
          <button
            className={cn(primaryButton, "mt-3")}
            disabled={busy || (!connection.configured && missingRequired)}
            onClick={submit}
            type="button"
          >
            {busy ? <LoaderCircle className="size-3 animate-spin" /> : null}
            {actionLabel}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ConnectionSettingsRow({
  busy,
  connection,
  onAuthenticate,
  onConfigureOAuth,
  onConfigureToken,
  onInstructions,
  onRemove,
  onRename,
  onRestart,
}: {
  busy: boolean;
  connection: PluginConnectionView;
  onAuthenticate: () => void;
  onConfigureOAuth: (input: { clientId: string; clientSecret: string; scope: string }) => void;
  onConfigureToken: (token: string) => void;
  onInstructions: (instructions: string) => void;
  onRemove: () => void;
  onRename: (alias: string) => void;
  onRestart: () => void;
}) {
  const [alias, setAlias] = useState(connection.alias);
  const [instructions, setInstructions] = useState(connection.instructions);
  const [token, setToken] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [oauthScope, setOauthScope] = useState("");
  const field =
    "h-8 rounded-[7px] border border-black/[0.08] bg-background px-2 text-[10.5px] outline-none dark:border-white/10 dark:bg-[#1d1d1d]";
  useEffect(() => setAlias(connection.alias), [connection.alias]);
  useEffect(() => setInstructions(connection.instructions), [connection.instructions]);
  return (
    <div className="border-t border-black/[0.055] px-3 py-3 first:border-t-0 dark:border-white/[0.065]">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">
          {connection.name} · {connection.alias}
        </span>
        <span className="text-[10px] capitalize text-foreground-tertiary">
          {connection.transport} · {connection.status.replace("_", " ")}
        </span>
        {connection.auth === "oauth" && connection.status !== "ready" ? (
          <button
            className={secondaryButton}
            disabled={busy}
            onClick={onAuthenticate}
            type="button"
          >
            {connection.authorizationUrl ? "Reopen" : "Authenticate"}
          </button>
        ) : null}
        <button className={secondaryButton} disabled={busy} onClick={onRestart} type="button">
          Restart
        </button>
      </div>
      <div className="mt-3 grid grid-cols-[minmax(110px,0.7fr)_minmax(180px,1.4fr)_auto] gap-2 max-sm:grid-cols-1">
        <input
          aria-label="Account alias"
          className={field}
          onChange={(e) => setAlias(e.target.value)}
          value={alias}
        />
        <input
          aria-label="Connector instructions"
          className={field}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Instructions, e.g. reply in threads"
          value={instructions}
        />
        <div className="flex gap-1.5">
          <button
            className={secondaryButton}
            disabled={busy || alias.trim() === connection.alias}
            onClick={() => onRename(alias.trim())}
            type="button"
          >
            Rename
          </button>
          <button
            className={secondaryButton}
            disabled={busy || instructions.trim() === connection.instructions}
            onClick={() => onInstructions(instructions)}
            type="button"
          >
            Save
          </button>
        </div>
      </div>
      {connection.auth === "token" && connection.status !== "ready" ? (
        <div className="mt-2 flex gap-2">
          <input
            aria-label="Bearer token"
            className={cn(field, "min-w-0 flex-1 font-mono")}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Bearer token"
            type="password"
            value={token}
          />
          <button
            className={secondaryButton}
            disabled={busy || !token}
            onClick={() => onConfigureToken(token)}
            type="button"
          >
            Save token
          </button>
        </div>
      ) : null}
      {connection.auth === "oauth" && connection.status !== "ready" ? (
        <div className="mt-3 rounded-[9px] bg-black/[0.035] p-3 dark:bg-black/20">
          <div className="mb-2 text-[10.5px] leading-4 text-foreground-secondary">
            Self-hosted OAuth clients must allow this callback URL:
            <code className="mt-1 block select-all break-all text-[10px] text-foreground">
              {connection.oauthRedirectUrl}
            </code>
          </div>
          <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
            <input
              aria-label="OAuth client ID"
              className={field}
              onChange={(event) => setOauthClientId(event.target.value)}
              placeholder="OAuth client ID"
              value={oauthClientId}
            />
            <input
              aria-label="OAuth client secret"
              className={field}
              onChange={(event) => setOauthClientSecret(event.target.value)}
              placeholder="OAuth client secret (optional)"
              type="password"
              value={oauthClientSecret}
            />
            <input
              aria-label="OAuth scopes"
              className={cn(field, "col-span-2 max-sm:col-span-1")}
              onChange={(event) => setOauthScope(event.target.value)}
              placeholder="Scopes (optional, space separated)"
              value={oauthScope}
            />
          </div>
          <button
            className={cn(secondaryButton, "mt-2")}
            disabled={busy || !oauthClientId.trim()}
            onClick={() =>
              onConfigureOAuth({
                clientId: oauthClientId.trim(),
                clientSecret: oauthClientSecret,
                scope: oauthScope.trim(),
              })
            }
            type="button"
          >
            Save client and authenticate
          </button>
        </div>
      ) : null}
      <button
        className="mt-3 text-[10.5px] text-red-600 hover:underline dark:text-red-400"
        disabled={busy}
        onClick={onRemove}
        type="button"
      >
        Remove account
      </button>
    </div>
  );
}

function PluginDetail({
  accessEpoch,
  busy,
  data,
  plugin,
  onAddAccount,
  onGrant,
  onAuthenticate,
  onConfigureToken,
  onConfigureOAuth,
  onInstructions,
  onInstall,
  onPolicy,
  onRemoveAccount,
  onRename,
  onRemove,
  onRestart,
  onSkill,
  onToggle,
}: {
  accessEpoch: number;
  busy: string | null;
  data: PluginSettingsView;
  plugin: PluginCatalogItemView;
  onAddAccount: (connection: PluginConnectionView) => void;
  onGrant: (
    connection: PluginConnectionView,
    bot: PluginBotAccessItemView,
    enabled: boolean
  ) => void;
  onAuthenticate: (connection: PluginConnectionView) => void;
  onConfigureToken: (connection: PluginConnectionView, token: string) => void;
  onConfigureOAuth: (
    connection: PluginConnectionView,
    input: { clientId: string; clientSecret: string; scope: string }
  ) => void;
  onInstructions: (connection: PluginConnectionView, instructions: string) => void;
  onInstall: (plugin: PluginCatalogItemView, values?: Record<string, string>) => void;
  onPolicy: (connectionId: string, toolName: string, decision: "deny" | "prompt" | "allow") => void;
  onRemoveAccount: (connection: PluginConnectionView) => void;
  onRename: (connection: PluginConnectionView, alias: string) => void;
  onRemove: (plugin: PluginCatalogItemView) => void;
  onRestart: (connection: PluginConnectionView) => void;
  onSkill: (pluginKey: string, bot: PluginBotAccessItemView, enabled: boolean) => void;
  onToggle: (connection: PluginConnectionView) => void;
}) {
  const [setupValues, setSetupValues] = useState<Record<string, string>>({});
  const [shared, setShared] = useState(false);
  const [botAccessExpanded, setBotAccessExpanded] = useState(false);
  const [botAccessQuery, setBotAccessQuery] = useState("");
  const [botAccessOffset, setBotAccessOffset] = useState(0);
  const [botAccess, setBotAccess] = useState<PluginBotAccessView | null>(null);
  const [botAccessLoading, setBotAccessLoading] = useState(false);
  const [botAccessError, setBotAccessError] = useState<string | null>(null);
  const install = installFor(data, plugin.key);
  const connections = install?.connections ?? [];
  const hasBotAccess = Boolean(install && (install.connections.length || install.hasSkills));
  const botAccessScope = install ? `${accessEpoch}:${install.id}` : "";
  const needsAuth = connections.find((connection) => connection.status === "needs_auth");
  const setupConnection = plugin.setup?.connectionKey
    ? connections.find((connection) => connection.connectorKey === plugin.setup?.connectionKey)
    : connections[0];
  const recentActivity = data.activity
    .filter((entry) => entry.pluginKey === plugin.key)
    .slice(0, 8);
  useEffect(() => {
    if (!botAccessScope || !hasBotAccess) {
      setBotAccess(null);
      return;
    }
    if (!botAccessExpanded) return;
    const controller = new AbortController();
    setBotAccess(null);
    setBotAccessError(null);
    const timer = window.setTimeout(
      () => {
        setBotAccessLoading(true);
        api
          .pluginBotAccess(plugin.key, {
            query: botAccessQuery,
            offset: botAccessOffset,
            limit: PLUGIN_BOT_ACCESS_PAGE_SIZE,
            signal: controller.signal,
          })
          .then(setBotAccess)
          .catch((cause) => {
            if (!controller.signal.aborted) setBotAccessError(errorMessage(cause));
          })
          .finally(() => {
            if (!controller.signal.aborted) setBotAccessLoading(false);
          });
      },
      botAccessQuery ? 150 : 0
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    botAccessExpanded,
    botAccessOffset,
    botAccessQuery,
    botAccessScope,
    hasBotAccess,
    plugin.key,
  ]);
  const botAccessWindow = useMemo(
    () => pluginBotAccessWindow(botAccess?.bots ?? [], "", PLUGIN_BOT_ACCESS_PAGE_SIZE),
    [botAccess]
  );
  const visibleBots = botAccessWindow.items;
  const shareUrl =
    plugin.sourceUrl ??
    plugin.homepageUrl ??
    `grokbot://app/v1/plugin/add?id=${encodeURIComponent(plugin.key)}`;
  const sharePlugin = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: plugin.name, text: plugin.description, url: shareUrl });
      } else {
        await navigator.clipboard.writeText(shareUrl);
      }
      setShared(true);
      window.setTimeout(() => setShared(false), 1_500);
    } catch {
      // Cancelling the system share sheet leaves the detail view unchanged.
    }
  };
  return (
    <div className="grok-scrollbar h-[624px] overflow-y-auto px-8 pb-8">
      <div className="flex items-start gap-3 pt-1">
        <PluginMark logoUrl={plugin.logoUrl} name={plugin.name} size="lg" />
        <div className="min-w-0 flex-1 pt-1">
          <div className="flex items-center gap-1.5 text-[14px] font-medium">{plugin.name}</div>
          <div className="mt-0.5 text-[11px] text-foreground-secondary">{plugin.publisher}</div>
          {plugin.sourceUrl || plugin.homepageUrl ? (
            <a
              className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-foreground-secondary hover:text-foreground"
              href={plugin.sourceUrl ?? plugin.homepageUrl ?? undefined}
              rel="noreferrer"
              target="_blank"
            >
              View Source <ExternalLink className="size-2.5" />
            </a>
          ) : null}
        </div>
        <button className={secondaryButton} onClick={() => void sharePlugin()} type="button">
          {shared ? "Copied" : "Share"}
        </button>
        {!install ? (
          <button
            className={primaryButton}
            disabled={plugin.setupFields.some(
              (field) => field.required && !setupValues[field.key]?.trim()
            )}
            onClick={() => onInstall(plugin, setupValues)}
            type="button"
          >
            {busy === plugin.key ? <LoaderCircle className="size-3 animate-spin" /> : null}
            Add
          </button>
        ) : needsAuth ? (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-amber-500/10 px-3 text-[10.5px] text-amber-700 dark:text-amber-300">
            Setup required
          </span>
        ) : (
          <span className="inline-flex h-7 items-center gap-1 text-[11.5px] text-[#00a86b]">
            <Check className="size-3.5" /> Added
          </span>
        )}
      </div>
      <p className="mt-4 max-w-[720px] text-[12px] leading-[18px] text-foreground-secondary">
        {plugin.description}
      </p>

      {setupConnection && plugin.setup ? (
        <PluginSetupCard
          busy={busy === setupConnection.id}
          connection={setupConnection}
          onAuthenticate={() => onAuthenticate(setupConnection)}
          onConfigureOAuth={(input) => onConfigureOAuth(setupConnection, input)}
          onConfigureToken={(token) => onConfigureToken(setupConnection, token)}
          plugin={plugin}
        />
      ) : null}

      {!install && plugin.setupFields.length ? (
        <div className="mt-5 grid grid-cols-2 gap-2 rounded-[10px] bg-black/[0.035] p-3 dark:bg-white/[0.045] max-sm:grid-cols-1">
          {plugin.setupFields.map((field) => (
            <label className="space-y-1" key={field.key}>
              <span className="block text-[10.5px] text-foreground-secondary">{field.label}</span>
              <input
                className="h-8 w-full rounded-[7px] border border-black/[0.08] bg-background px-2.5 text-[11px] outline-none dark:border-white/[0.09]"
                onChange={(event) =>
                  setSetupValues((current) => ({ ...current, [field.key]: event.target.value }))
                }
                type={field.secret ? "password" : "text"}
                value={setupValues[field.key] ?? ""}
              />
            </label>
          ))}
        </div>
      ) : null}

      {plugin.connections.length ? (
        <DetailBlock count={connections.length || plugin.connections.length} label="Connectors">
          {(connections.length ? connections : plugin.connections).map((connection) => {
            const live = "id" in connection ? (connection as PluginConnectionView) : null;
            return (
              <div
                className="flex min-h-9 items-center gap-3 border-t border-black/[0.055] px-3 first:border-t-0 dark:border-white/[0.065]"
                key={
                  live ? live.id : (connection as PluginCatalogItemView["connections"][number]).key
                }
              >
                <span className="min-w-0 flex-1 truncate text-[11.5px]">
                  {live
                    ? `${live.name}${live.alias === "default" ? "" : ` · ${live.alias}`}`
                    : connection.name}
                </span>
                {live ? (
                  <>
                    <span className="text-[10.5px] capitalize text-foreground-tertiary">
                      {live.status === "needs_auth" ? "Needs authentication" : live.status}
                    </span>
                    <button
                      className={secondaryButton}
                      onClick={() => onToggle(live)}
                      type="button"
                    >
                      {live.status === "ready" ? "Disconnect" : "Connect"}
                    </button>
                    <button
                      className="text-[10.5px] text-foreground-tertiary hover:text-foreground"
                      onClick={() => onAddAccount(live)}
                      type="button"
                    >
                      Add account
                    </button>
                  </>
                ) : (
                  <span className="text-[10.5px] text-foreground-tertiary">Connector</span>
                )}
              </div>
            );
          })}
        </DetailBlock>
      ) : null}

      {connections.length ? (
        <DetailBlock count={connections.length} label="Accounts" open={false}>
          {connections.map((connection) => (
            <ConnectionSettingsRow
              busy={busy === connection.id}
              connection={connection}
              key={connection.id}
              onAuthenticate={() => onAuthenticate(connection)}
              onConfigureOAuth={(input) => onConfigureOAuth(connection, input)}
              onConfigureToken={(token) => onConfigureToken(connection, token)}
              onInstructions={(instructions) => onInstructions(connection, instructions)}
              onRemove={() => onRemoveAccount(connection)}
              onRename={(alias) => onRename(connection, alias)}
              onRestart={() => onRestart(connection)}
            />
          ))}
        </DetailBlock>
      ) : null}

      {plugin.skills.length ? (
        <DetailBlock count={plugin.skills.length} label="Skills">
          {plugin.skills.map((skill) => (
            <div
              className="flex min-h-9 items-center gap-3 border-t border-black/[0.055] px-3 first:border-t-0 dark:border-white/[0.065]"
              key={skill.name}
            >
              <span className="shrink-0 text-[11.5px]">{skill.name}</span>
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-foreground-secondary">
                {skill.description}
              </span>
            </div>
          ))}
        </DetailBlock>
      ) : null}

      {install && (connections.length || install.hasSkills) && data.botCount > 0 ? (
        <DetailBlock
          count={botAccessQuery ? (botAccess?.total ?? 0) : data.botCount}
          label="Bot access"
          onOpenChange={setBotAccessExpanded}
          open={false}
        >
          {botAccessExpanded ? (
            <>
              {botAccessQuery || data.botCount > PLUGIN_BOT_ACCESS_PAGE_SIZE ? (
                <div className="border-t border-black/[0.055] p-2 first:border-t-0 dark:border-white/[0.065]">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-foreground-tertiary" />
                    <input
                      aria-label="Filter Bot access"
                      className="h-8 w-full rounded-[8px] border border-black/[0.07] bg-background pl-8 pr-2.5 text-[11px] outline-none placeholder:text-foreground-tertiary focus:border-black/15 dark:border-white/[0.09] dark:focus:border-white/20"
                      maxLength={PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH}
                      onChange={(event) => {
                        setBotAccessOffset(0);
                        setBotAccessQuery(event.target.value);
                      }}
                      placeholder="Filter Bots"
                      value={botAccessQuery}
                    />
                  </div>
                </div>
              ) : null}
              {connections.map((connection) => (
                <div
                  className="flex min-h-10 items-center gap-3 border-t border-black/[0.055] px-3 first:border-t-0 dark:border-white/[0.065]"
                  key={connection.id}
                >
                  <span className="min-w-[145px] flex-1 truncate text-[11.5px]">
                    {connection.name}
                  </span>
                  <div className="flex flex-wrap justify-end gap-3">
                    {visibleBots.map((bot) => {
                      const checked = bot.grantedConnectionIds.includes(connection.id);
                      const key = `${connection.id}:${bot.id}`;
                      return (
                        <div
                          className="flex items-center gap-1.5 text-[10.5px] text-foreground-secondary"
                          key={bot.id}
                        >
                          <span className="max-w-24 truncate">{bot.name}</span>
                          <SquareToggle
                            busy={busy === key}
                            checked={checked}
                            label={`${checked ? "Revoke" : "Grant"} ${connection.name} for ${bot.name}`}
                            onClick={() => onGrant(connection, bot, !checked)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {install.hasSkills ? (
                <div className="flex min-h-10 items-center gap-3 border-t border-black/[0.055] px-3 dark:border-white/[0.065]">
                  <span className="min-w-[145px] flex-1 truncate text-[11.5px]">Plugin skills</span>
                  <div className="flex flex-wrap justify-end gap-3">
                    {visibleBots.map((bot) => {
                      const checked = bot.skillsEnabled;
                      const key = `skill:${plugin.key}:${bot.id}`;
                      return (
                        <div
                          className="flex items-center gap-1.5 text-[10.5px] text-foreground-secondary"
                          key={bot.id}
                        >
                          <span className="max-w-24 truncate">{bot.name}</span>
                          <SquareToggle
                            busy={busy === key}
                            checked={checked}
                            label={`${checked ? "Disable" : "Enable"} ${plugin.name} skills for ${bot.name}`}
                            onClick={() => onSkill(plugin.key, bot, !checked)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              {botAccess &&
              (botAccess.offset > 0 ||
                botAccess.offset + botAccess.bots.length < botAccess.total) ? (
                <div className="flex h-9 items-center justify-between border-t border-black/[0.055] px-3 text-[10.5px] text-foreground-secondary dark:border-white/[0.065]">
                  <button
                    className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-35"
                    disabled={botAccessLoading || botAccess.offset === 0}
                    onClick={() =>
                      setBotAccessOffset(
                        Math.max(0, botAccess.offset - PLUGIN_BOT_ACCESS_PAGE_SIZE)
                      )
                    }
                    type="button"
                  >
                    <ChevronLeft className="size-3" /> Previous
                  </button>
                  <span>
                    {botAccess.bots.length ? botAccess.offset + 1 : 0}–
                    {botAccess.offset + botAccess.bots.length} of {botAccess.total}
                  </span>
                  <button
                    className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-35"
                    disabled={
                      botAccessLoading ||
                      botAccess.offset + botAccess.bots.length >= botAccess.total
                    }
                    onClick={() =>
                      setBotAccessOffset(botAccess.offset + PLUGIN_BOT_ACCESS_PAGE_SIZE)
                    }
                    type="button"
                  >
                    Next <ChevronRight className="size-3" />
                  </button>
                </div>
              ) : null}
              {botAccessLoading && !botAccess ? (
                <div className="grid h-12 place-items-center border-t border-black/[0.055] dark:border-white/[0.065]">
                  <LoaderCircle className="size-3.5 animate-spin text-foreground-tertiary" />
                </div>
              ) : null}
              {botAccess && botAccess.total === 0 ? (
                <div className="border-t border-black/[0.055] px-3 py-3 text-[10.5px] text-foreground-tertiary dark:border-white/[0.065]">
                  No Bots match that filter.
                </div>
              ) : null}
              {botAccessError ? (
                <div className="border-t border-black/[0.055] px-3 py-3 text-[10.5px] text-red-600 dark:border-white/[0.065] dark:text-red-400">
                  {botAccessError}
                </div>
              ) : null}
            </>
          ) : null}
        </DetailBlock>
      ) : null}

      {connections.some((connection) => connection.tools.length) ? (
        <DetailBlock
          count={connections.reduce((total, connection) => total + connection.tools.length, 0)}
          label="Tool policies"
          open={false}
        >
          {connections.flatMap((connection) =>
            connection.tools.map((tool) => {
              const policy = data.policies.find(
                (candidate) =>
                  candidate.connectionId === connection.id &&
                  candidate.botId === null &&
                  candidate.toolName === tool.name
              );
              const key = `${connection.id}:${tool.name}`;
              return (
                <div
                  className="flex min-h-10 items-center gap-3 border-t border-black/[0.055] px-3 first:border-t-0 dark:border-white/[0.065]"
                  key={key}
                >
                  <span className="min-w-0 flex-1 truncate text-[11.5px]">{tool.name}</span>
                  <Suspense
                    fallback={
                      <span className="inline-flex h-7 items-center rounded-[7px] border border-black/[0.07] bg-background px-2 text-[10.5px] capitalize text-foreground-secondary dark:border-white/[0.09]">
                        {policy?.decision ?? tool.defaultDecision}
                      </span>
                    }
                  >
                    <PluginPolicySelect
                      disabled={busy === key}
                      label={`Policy for ${tool.name}`}
                      onChange={(value) => onPolicy(connection.id, tool.name, value)}
                      value={policy?.decision ?? tool.defaultDecision}
                    />
                  </Suspense>
                </div>
              );
            })
          )}
        </DetailBlock>
      ) : null}

      {recentActivity.length ? (
        <DetailBlock count={recentActivity.length} label="Activity" open={false}>
          {recentActivity.map((entry) => (
            <div
              className="flex min-h-10 items-center gap-3 border-t border-black/[0.055] px-3 text-[10.5px] first:border-t-0 dark:border-white/[0.065]"
              key={entry.id}
            >
              <span className="min-w-0 flex-1 truncate">{entry.summary}</span>
              <span className="text-foreground-tertiary">
                {new Date(entry.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </DetailBlock>
      ) : null}

      {install ? (
        <button
          className="mt-8 px-1 text-[11px] text-red-600 hover:underline dark:text-red-400"
          onClick={() => onRemove(plugin)}
          type="button"
        >
          Remove plugin
        </button>
      ) : null}
    </div>
  );
}

export function PluginDialog({
  onOpenChange,
  open,
  target,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  target?: { pluginId: string; nonce: number } | null;
}) {
  const [page, setPage] = useState<MarketplacePage>("marketplace");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [data, setData] = useState<PluginSettingsView | null>(null);
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeArmed, setRemoveArmed] = useState<string | null>(null);

  const refresh = useMemo(
    () =>
      createCoalescedRefresh(api.pluginSettings, (settings) => {
        setData(settings);
        setSettingsEpoch((epoch) => epoch + 1);
      }),
    []
  );
  const needsAuthConnectionIds = useMemo(
    () =>
      (data?.installs ?? [])
        .flatMap((install) => install.connections)
        .filter((connection) => connection.status === "needs_auth")
        .map((connection) => connection.id)
        .sort(),
    [data]
  );
  const statusRefresh = useMemo(
    () =>
      createCoalescedRefresh(
        () => api.pluginConnectionStatuses(needsAuthConnectionIds),
        (statuses) => {
          setData((current) =>
            current ? mergePluginConnectionStatuses(current, statuses) : current
          );
        }
      ),
    [needsAuthConnectionIds]
  );
  useEffect(() => {
    if (!open) return;
    refresh().catch((cause) => setError(errorMessage(cause)));
  }, [open, refresh]);
  const needsPluginAuthentication = needsAuthConnectionIds.length > 0;
  useEffect(() => {
    if (!open || !needsPluginAuthentication) return;
    const timer = window.setInterval(() => {
      statusRefresh().catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [needsPluginAuthentication, open, statusRefresh]);
  useEffect(() => {
    if (open) return;
    setPage("marketplace");
    setSelectedKey(null);
    setError(null);
    setRemoveArmed(null);
  }, [open]);

  const mutate = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      setBusy(key);
      setError(null);
      try {
        await action();
        await refresh();
        return true;
      } catch (cause) {
        setError(errorMessage(cause));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [refresh]
  );

  const selected = useMemo(() => {
    const catalogPlugin = data?.catalog.find((plugin) => plugin.key === selectedKey);
    if (catalogPlugin) return catalogPlugin;
    const install = data?.installs.find((plugin) => plugin.pluginKey === selectedKey);
    return install ? catalogPluginForInstall(install) : null;
  }, [data, selectedKey]);
  const openDetail = (plugin: PluginCatalogItemView) => {
    void loadPluginSettingsDetail();
    setSelectedKey(plugin.key);
    setPage("detail");
    setError(null);
    setRemoveArmed(null);
  };
  useEffect(() => {
    if (!open || !target || !data) return;
    const plugin = data.catalog.find((candidate) => candidate.key === target.pluginId);
    if (plugin) {
      setSelectedKey(plugin.key);
      setPage("detail");
      setError(null);
      setRemoveArmed(null);
      return;
    }
    setPage("marketplace");
    setSelectedKey(null);
    setError(`Plugin “${target.pluginId}” is not available in this catalog.`);
  }, [data, open, target]);
  const authenticateConnection = (connection: PluginConnectionView) => {
    if (connection.authorizationUrl) {
      window.open(connection.authorizationUrl, "_blank", "noopener,noreferrer");
      return;
    }
    void mutate(connection.id, async () => {
      const result = await api.authenticatePlugin(connection.id);
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
      return result;
    });
  };
  const toggleConnection = (connection: PluginConnectionView) => {
    if (connection.status !== "ready" && connection.auth === "oauth") {
      authenticateConnection(connection);
      return;
    }
    void mutate(connection.id, () =>
      connection.status === "ready"
        ? api.disconnectPlugin(connection.id)
        : api.connectPlugin(connection.id)
    );
  };

  const title =
    page === "detail" && selected
      ? selected.name
      : page === "custom"
        ? "Add custom MCP"
        : "Plugins";
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="h-[min(700px,calc(100vh-96px))] w-[min(1000px,calc(100vw-40px))] max-w-none gap-0 overflow-hidden rounded-[13px] border-black/10 bg-background p-0 text-foreground shadow-[0_24px_72px_rgba(0,0,0,0.24)] dark:border-[#303030]"
        onOpenAutoFocus={(event) => event.preventDefault()}
        showCloseButton={false}
        surface={page === "detail" ? "transparent" : "modal"}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          Browse, install, connect, and configure OpenBot plugins.
        </DialogDescription>
        <header className="relative flex h-[66px] shrink-0 items-center px-8">
          {page === "detail" || page === "custom" ? (
            <button
              aria-label="Back to Marketplace"
              className="absolute left-3.5 grid size-8 place-items-center rounded-full text-foreground-secondary outline-none hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              onClick={() => setPage(page === "custom" ? "installed" : "marketplace")}
              type="button"
            >
              <ChevronLeft className="size-4" />
            </button>
          ) : null}
          {page === "detail" || page === "custom" ? (
            <div className="w-full text-center text-[12px] font-medium">{title}</div>
          ) : (
            <div className="text-[14px] font-medium">Plugins</div>
          )}
          <button
            aria-label="Close plugins"
            className="absolute right-3.5 grid size-8 place-items-center rounded-full text-foreground-tertiary outline-none transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            <X className="size-4" strokeWidth={1.7} />
          </button>
        </header>
        {error ? (
          <div className="mx-8 mb-3 rounded-[8px] bg-red-500/10 px-3 py-2 text-[11px] text-red-700 dark:text-red-300">
            {error}
          </div>
        ) : null}
        {!data ? (
          <div className="grid flex-1 place-items-center">
            <LoaderCircle className="size-5 animate-spin text-foreground-tertiary" />
          </div>
        ) : page === "marketplace" ? (
          <MarketplaceView
            busy={busy}
            data={data}
            onInstall={(plugin) => {
              if (plugin.setup || plugin.setupFields.length) {
                openDetail(plugin);
                void mutate(plugin.key, () => api.installPlugin(plugin.key));
              } else {
                void mutate(plugin.key, () => api.installPlugin(plugin.key));
              }
            }}
            onOpen={openDetail}
            onShowInstalled={() => setPage("installed")}
          />
        ) : page === "installed" ? (
          <InstalledView
            busy={busy}
            data={data}
            onBack={() => setPage("marketplace")}
            onCustom={() => {
              void loadPluginSettingsDetail();
              setPage("custom");
            }}
            onOpen={openDetail}
          />
        ) : page === "custom" ? (
          <CustomMcpView
            busy={busy === "custom-mcp"}
            onBack={() => setPage("installed")}
            onSubmit={(input) =>
              void mutate("custom-mcp", () => api.addCustomMcp(input)).then((created) => {
                if (created) setPage("installed");
              })
            }
          />
        ) : selected ? (
          <PluginDetail
            accessEpoch={settingsEpoch}
            busy={busy}
            data={data}
            key={selected.key}
            onAddAccount={(connection) => {
              const alias = window.prompt(`Name the additional ${connection.name} account`, "work");
              if (alias?.trim())
                void mutate(`account:${connection.id}`, () =>
                  api.addPluginAccount(connection.id, alias.trim())
                );
            }}
            onGrant={(connection, bot, enabled) => {
              const transition = planPluginConnectionGrant(
                selected.key,
                bot,
                connection.id,
                enabled
              );
              void mutate(`${connection.id}:${bot.id}`, () =>
                executePluginAccessTransition(transition, {
                  setEnablement: api.setPluginEnablement,
                  setGrant: api.setPluginGrant,
                })
              );
            }}
            onAuthenticate={authenticateConnection}
            onConfigureToken={(connection, token) =>
              void mutate(connection.id, async () => {
                await api.configurePluginConnection(connection.id, { token });
                return api.connectPlugin(connection.id);
              })
            }
            onConfigureOAuth={(connection, input) =>
              void mutate(connection.id, async () => {
                await api.configurePluginConnection(connection.id, input);
                const result = await api.authenticatePlugin(connection.id);
                window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
                return result;
              })
            }
            onInstructions={(connection, instructions) =>
              void mutate(connection.id, () => api.setMcpInstructions(connection.id, instructions))
            }
            onInstall={(plugin, values) =>
              void mutate(plugin.key, () => api.installPlugin(plugin.key, values))
            }
            onPolicy={(connectionId, toolName, decision) =>
              void mutate(`${connectionId}:${toolName}`, () =>
                api.setPluginPolicy(connectionId, { botId: null, toolName, decision })
              )
            }
            onRemoveAccount={(connection) =>
              void mutate(connection.id, () => api.removePluginAccount(connection.id))
            }
            onRename={(connection, alias) =>
              void mutate(connection.id, () => api.renamePluginAccount(connection.id, alias))
            }
            onRemove={(plugin) => {
              if (removeArmed !== plugin.key) {
                setRemoveArmed(plugin.key);
                setError(`Click “Remove plugin” again to remove ${plugin.name}.`);
                return;
              }
              void mutate(plugin.key, () => api.uninstallPlugin(plugin.key)).then((removed) => {
                if (!removed) return;
                setPage("marketplace");
                setSelectedKey(null);
                setRemoveArmed(null);
              });
            }}
            onSkill={(pluginKey, bot, enabled) => {
              const transition = planPluginSkillAccess(pluginKey, bot, enabled);
              void mutate(`skill:${pluginKey}:${bot.id}`, () =>
                executePluginAccessTransition(transition, {
                  setEnablement: api.setPluginEnablement,
                  setGrant: api.setPluginGrant,
                })
              );
            }}
            onRestart={(connection) =>
              void mutate(connection.id, () => api.restartPluginConnection(connection.id))
            }
            onToggle={toggleConnection}
            plugin={selected}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
