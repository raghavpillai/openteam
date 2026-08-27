import type {
  PluginCatalogItemView,
  PluginConnectionView,
  PluginInstallView,
  PluginSettingsView,
} from "@openbot/contracts";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  Plus,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../client/openbot-api";
import { cn } from "../../lib/cn";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

type MarketplacePage = "marketplace" | "installed" | "detail";

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
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-full bg-black px-3 text-[11.5px] font-medium text-white outline-none transition-opacity hover:opacity-80 disabled:cursor-wait disabled:opacity-45 dark:bg-white dark:text-black";
const secondaryButton =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-full bg-black/[0.055] px-3 text-[11.5px] text-foreground outline-none transition-colors hover:bg-black/[0.09] disabled:cursor-wait disabled:opacity-45 dark:bg-[#222222] dark:hover:bg-[#2b2b2b]";

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function PluginMark({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const google = name.startsWith("Google") || name === "Gmail";
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-[11px] bg-black/[0.055] font-medium dark:bg-[#373737]",
        size === "sm" && "size-8 text-[12px]",
        size === "md" && "size-9 text-[13px]",
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
        className="h-[29px] w-full rounded-[8px] border border-black/[0.055] bg-black/[0.045] pl-[31px] pr-3 text-[12px] outline-none placeholder:text-foreground-tertiary focus:border-black/10 dark:border-white/[0.07] dark:bg-[#292929]"
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
      <span className="inline-flex h-7 shrink-0 items-center gap-1 px-1 text-[11.5px] text-[#00a86b]">
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
        className="flex min-w-0 flex-1 items-center gap-2.5 py-2 text-left outline-none"
        onClick={() => onOpen(plugin)}
        type="button"
      >
        <PluginMark name={plugin.name} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[12px] font-medium leading-4">
            <span className="truncate">{plugin.name}</span>
            {plugin.featured ? (
              <span className="rounded-full bg-black/[0.055] px-1.5 py-0.5 text-[8px] font-normal uppercase tracking-[0.04em] text-foreground-tertiary dark:bg-white/[0.08]">
                Featured
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-[11px] leading-4 text-foreground-secondary">
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
        className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left outline-none"
        onClick={() => onOpen(plugin)}
        type="button"
      >
        <PluginMark name={plugin.name} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[12px] font-medium leading-4">
            <span>{plugin.name}</span>
          </span>
          <span className="mt-0.5 block truncate text-[11px] leading-4 text-foreground-secondary">
            {plugin.description}
          </span>
        </span>
      </button>
      <InstallAction busy={busy} onInstall={onInstall} plugin={plugin} />
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <div className="px-2 text-[10.5px] text-foreground-tertiary">{children}</div>;
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
    <div className="space-y-7 pb-8 pt-1">
      {featured.length ? (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <SectionHeading>Featured</SectionHeading>
            <span className="px-2 text-[10.5px] text-foreground-tertiary">View all</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 max-sm:grid-cols-1">
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
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 max-sm:grid-cols-1">
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
    <div className="px-7 pb-5">
      {data.installs.length ? (
        <button
          className="mb-4 flex h-8 items-center gap-2 rounded-[8px] px-1 text-left outline-none transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.035]"
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
      <div className="mt-2 flex flex-wrap gap-1.5">
        {marketplaceCategories.map((item) => (
          <button
            className={cn(
              "h-[23px] rounded-[6px] border px-2 text-[10.5px] outline-none transition-colors",
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
      <div className="grok-scrollbar mt-6 h-[374px] overflow-y-auto pr-1">
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

function InstalledRow({
  busy,
  install,
  onOpen,
  onToggle,
}: {
  busy: string | null;
  install: PluginInstallView;
  onOpen: () => void;
  onToggle: (connection: PluginConnectionView) => void;
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
          onClick={() => onToggle(needsAuth)}
          type="button"
        >
          {busy === needsAuth.id ? <LoaderCircle className="size-3 animate-spin" /> : null}
          Authenticate
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
  onToggle,
}: {
  busy: string | null;
  data: PluginSettingsView;
  onCustom: () => void;
  onBack: () => void;
  onOpen: (plugin: PluginCatalogItemView) => void;
  onToggle: (connection: PluginConnectionView) => void;
}) {
  const [query, setQuery] = useState("");
  const installs = data.installs.filter((plugin) =>
    `${plugin.name} ${plugin.description}`.toLowerCase().includes(query.trim().toLowerCase())
  );
  return (
    <div className="px-7 pb-6">
      <button
        className="mb-5 inline-flex items-center gap-1 text-[11px] text-foreground-secondary hover:text-foreground"
        onClick={onBack}
        type="button"
      >
        <ChevronLeft className="size-3.5" /> Back to Marketplace
      </button>
      <SearchField onChange={setQuery} query={query} />
      <div className="grok-scrollbar mt-7 h-[420px] overflow-y-auto pr-1">
        <section>
          <SectionHeading>Installed</SectionHeading>
          <div className="mt-2 max-w-[390px] space-y-0.5">
            {installs.length ? (
              installs.map((install) => {
                const plugin = data.catalog.find(
                  (candidate) => candidate.key === install.pluginKey
                );
                return (
                  <InstalledRow
                    busy={busy}
                    install={install}
                    key={install.id}
                    onOpen={() => plugin && onOpen(plugin)}
                    onToggle={onToggle}
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

function DetailBlock({
  children,
  count,
  label,
  open = true,
}: {
  children: React.ReactNode;
  count: number;
  label: string;
  open?: boolean;
}) {
  const singular =
    label === "Connectors"
      ? "connector"
      : label === "Skills"
        ? "skill"
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

function PluginDetail({
  busy,
  data,
  plugin,
  onAddAccount,
  onGrant,
  onInstall,
  onPolicy,
  onRemove,
  onSkill,
  onToggle,
}: {
  busy: string | null;
  data: PluginSettingsView;
  plugin: PluginCatalogItemView;
  onAddAccount: (connection: PluginConnectionView) => void;
  onGrant: (connection: PluginConnectionView, botId: string, enabled: boolean) => void;
  onInstall: (plugin: PluginCatalogItemView) => void;
  onPolicy: (connectionId: string, toolName: string, decision: "deny" | "prompt" | "allow") => void;
  onRemove: (plugin: PluginCatalogItemView) => void;
  onSkill: (pluginKey: string, botId: string, enabled: boolean) => void;
  onToggle: (connection: PluginConnectionView) => void;
}) {
  const install = installFor(data, plugin.key);
  const connections = install?.connections ?? [];
  const needsAuth = connections.find((connection) => connection.status === "needs_auth");
  const recentActivity = data.activity
    .filter((entry) => entry.pluginKey === plugin.key)
    .slice(0, 8);
  return (
    <div className="grok-scrollbar h-[530px] overflow-y-auto px-7 pb-8">
      <div className="flex items-start gap-3 pt-1">
        <PluginMark name={plugin.name} size="lg" />
        <div className="min-w-0 flex-1 pt-1">
          <div className="flex items-center gap-1.5 text-[14px] font-medium">
            {plugin.name}
            <ExternalLink className="size-3 text-foreground-tertiary" />
          </div>
          <div className="mt-0.5 text-[11px] text-foreground-secondary">{plugin.publisher}</div>
        </div>
        {!install ? (
          <button className={primaryButton} onClick={() => onInstall(plugin)} type="button">
            {busy === plugin.key ? <LoaderCircle className="size-3 animate-spin" /> : null}
            Add
          </button>
        ) : needsAuth ? (
          <button className={secondaryButton} onClick={() => onToggle(needsAuth)} type="button">
            Authenticate
          </button>
        ) : (
          <span className="inline-flex h-7 items-center gap-1 text-[11.5px] text-[#00a86b]">
            <Check className="size-3.5" /> Added
          </span>
        )}
      </div>
      <p className="mt-4 max-w-[720px] text-[12px] leading-[18px] text-foreground-secondary">
        {plugin.description}
      </p>

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

      {install && (connections.length || install.hasSkills) && data.bots.length ? (
        <DetailBlock count={data.bots.length} label="Bot access" open={false}>
          {connections.map((connection) => (
            <div
              className="flex min-h-10 items-center gap-3 border-t border-black/[0.055] px-3 first:border-t-0 dark:border-white/[0.065]"
              key={connection.id}
            >
              <span className="min-w-[145px] flex-1 truncate text-[11.5px]">{connection.name}</span>
              <div className="flex flex-wrap justify-end gap-3">
                {data.bots.map((bot) => {
                  const checked = connection.grantedBotIds.includes(bot.id);
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
                        onClick={() => onGrant(connection, bot.id, !checked)}
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
                {data.bots.map((bot) => {
                  const checked = install.enabledBotIds.includes(bot.id);
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
                        onClick={() => onSkill(plugin.key, bot.id, !checked)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
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
                  <select
                    aria-label={`Policy for ${tool.name}`}
                    className="h-7 rounded-[7px] border border-black/[0.07] bg-background px-2 text-[10.5px] outline-none dark:border-white/[0.09]"
                    disabled={busy === key}
                    onChange={(event) =>
                      onPolicy(
                        connection.id,
                        tool.name,
                        event.target.value as "deny" | "prompt" | "allow"
                      )
                    }
                    value={policy?.decision ?? tool.defaultDecision}
                  >
                    <option value="deny">Deny</option>
                    <option value="prompt">Ask first</option>
                    <option value="allow">Allow</option>
                  </select>
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
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [page, setPage] = useState<MarketplacePage>("marketplace");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [data, setData] = useState<PluginSettingsView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeArmed, setRemoveArmed] = useState<string | null>(null);

  const refresh = useCallback(async () => setData(await api.pluginSettings()), []);
  useEffect(() => {
    if (!open) return;
    refresh().catch((cause) => setError(errorMessage(cause)));
  }, [open, refresh]);
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

  const selected = useMemo(
    () => data?.catalog.find((plugin) => plugin.key === selectedKey) ?? null,
    [data, selectedKey]
  );
  const openDetail = (plugin: PluginCatalogItemView) => {
    setSelectedKey(plugin.key);
    setPage("detail");
    setError(null);
    setRemoveArmed(null);
  };
  const toggleConnection = (connection: PluginConnectionView) =>
    void mutate(connection.id, () =>
      connection.status === "ready"
        ? api.disconnectPlugin(connection.id)
        : api.connectPlugin(connection.id)
    );
  const customMcp = () => {
    const name = window.prompt("Custom MCP server name");
    if (!name?.trim()) return;
    const url = window.prompt(`HTTPS MCP endpoint for ${name.trim()}`);
    if (!url?.trim()) return;
    const alias = window.prompt("Account alias", "default") ?? "default";
    void mutate("custom-mcp", () =>
      api.addCustomMcp(name.trim(), url.trim(), alias.trim() || "default")
    );
  };

  const title = page === "detail" && selected ? selected.name : "Plugins";
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="h-[min(606px,calc(100vh-48px))] w-[min(860px,calc(100vw-48px))] max-w-none gap-0 overflow-hidden rounded-[13px] border-black/10 bg-background p-0 text-foreground shadow-[0_24px_72px_rgba(0,0,0,0.24)]"
        onOpenAutoFocus={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          Browse, install, connect, and configure OpenBot plugins.
        </DialogDescription>
        <header className="relative flex h-[66px] shrink-0 items-center px-7">
          {page === "detail" ? (
            <button
              aria-label="Back to Marketplace"
              className="absolute left-3.5 grid size-8 place-items-center rounded-full text-foreground-secondary outline-none hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              onClick={() => setPage("marketplace")}
              type="button"
            >
              <ChevronLeft className="size-4" />
            </button>
          ) : null}
          {page === "detail" ? (
            <div className="w-full text-center text-[12px] font-medium">{selected?.name}</div>
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
          <div className="mx-7 mb-3 rounded-[8px] bg-red-500/10 px-3 py-2 text-[11px] text-red-700 dark:text-red-300">
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
            onInstall={(plugin) => void mutate(plugin.key, () => api.installPlugin(plugin.key))}
            onOpen={openDetail}
            onShowInstalled={() => setPage("installed")}
          />
        ) : page === "installed" ? (
          <InstalledView
            busy={busy}
            data={data}
            onBack={() => setPage("marketplace")}
            onCustom={customMcp}
            onOpen={openDetail}
            onToggle={toggleConnection}
          />
        ) : selected ? (
          <PluginDetail
            busy={busy}
            data={data}
            onAddAccount={(connection) => {
              const alias = window.prompt(`Name the additional ${connection.name} account`, "work");
              if (alias?.trim())
                void mutate(`account:${connection.id}`, () =>
                  api.addPluginAccount(connection.id, alias.trim())
                );
            }}
            onGrant={(connection, botId, enabled) =>
              void mutate(`${connection.id}:${botId}`, () =>
                api.setPluginGrant(connection.id, botId, enabled)
              )
            }
            onInstall={(plugin) => void mutate(plugin.key, () => api.installPlugin(plugin.key))}
            onPolicy={(connectionId, toolName, decision) =>
              void mutate(`${connectionId}:${toolName}`, () =>
                api.setPluginPolicy(connectionId, { botId: null, toolName, decision })
              )
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
            onSkill={(pluginKey, botId, enabled) =>
              void mutate(`skill:${pluginKey}:${botId}`, () =>
                api.setPluginEnablement(pluginKey, botId, enabled)
              )
            }
            onToggle={toggleConnection}
            plugin={selected}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
