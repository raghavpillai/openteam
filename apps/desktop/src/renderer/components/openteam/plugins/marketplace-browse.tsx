import type {
  PluginCatalogItemView,
  PluginConnectionView,
  PluginInstallView,
  PluginSettingsView,
} from "@openteam/contracts";
import type { PluginPrivateSkillView } from "@openteam/contracts/plugin-management";
import {
  pluginMatchesMarketplaceCategory,
  type PluginMarketplaceCategory,
} from "@openteam/client-core/plugin-marketplace";
import { Check, ChevronLeft, ChevronRight, LoaderCircle, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../../client/openteam-api";
import { cn } from "../../../lib/cn";
import { PluginMark } from "./plugin-mark";
import { MarketplaceCategories } from "./marketplace-categories";

const pill =
  "inline-flex h-[26px] shrink-0 cursor-pointer items-center justify-center gap-1 rounded-full bg-[#77777717] px-3 text-[12px] text-foreground outline-none transition-colors duration-120 ease-out hover:bg-[#7777772b] focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-45";
const categoryLabel = (value: string) =>
  value
    .replace("Documents & Files", "Documents and Files")
    .replace("Inbox & Collaboration", "Inbox and Collaboration");
function SearchField({ query, onChange }: { query: string; onChange: (value: string) => void }) {
  return (
    <label className="relative block">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-tertiary" />
      <input
        aria-label="Search plugins"
        placeholder="Search plugins"
        type="search"
        spellCheck={false}
        value={query}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded-full border border-black/[0.055] bg-black/[0.045] pl-8 pr-3 text-[13px] outline-none placeholder:text-foreground-tertiary focus:border-black/20 dark:border-white/[0.08] dark:bg-white/[0.06]"
      />
    </label>
  );
}
function PluginRow({
  plugin,
  busy,
  subtitle,
  action,
  onOpen,
  onInstall,
}: {
  plugin: PluginCatalogItemView;
  busy?: boolean;
  subtitle?: string;
  action?: React.ReactNode;
  onOpen: (plugin: PluginCatalogItemView) => void;
  onInstall?: (plugin: PluginCatalogItemView) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-2xl px-3 hover:bg-foreground/[0.05]">
      <button
        aria-label={`Open ${plugin.name}`}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md py-3 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
        onClick={() => onOpen(plugin)}
        type="button"
      >
        <PluginMark logoUrl={plugin.logoUrl} name={plugin.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-[18px]">
            {plugin.name}
          </span>
          <span className="block truncate text-[13px] leading-[18px] text-foreground-secondary">
            {subtitle ?? plugin.description}
          </span>
        </span>
      </button>
      {action ??
        (plugin.installed ? (
          <span className="inline-flex items-center gap-1 px-1 text-[12px] text-foreground-secondary">
            <Check className="size-3 text-emerald-600" />
            Added
          </span>
        ) : (
          <button
            className={pill}
            disabled={busy}
            onClick={() => onInstall?.(plugin)}
            type="button"
          >
            {busy && <LoaderCircle className="size-3 animate-spin" />}Add
          </button>
        ))}
    </div>
  );
}

export function MarketplaceView({
  hidden = false,
  busy,
  data,
  onInstall,
  onOpen,
  onShowInstalled,
}: {
  hidden?: boolean;
  busy: string | null;
  data: PluginSettingsView;
  onInstall: (plugin: PluginCatalogItemView) => void;
  onOpen: (plugin: PluginCatalogItemView) => void;
  onShowInstalled: () => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("All");
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = data.catalog.filter(
    (p) =>
      pluginMatchesMarketplaceCategory(p, category) &&
      `${p.name} ${p.description} ${p.publisher}`.toLocaleLowerCase().includes(normalized)
  );
  const grouped = category === "All" && !normalized;
  const groups = [...new Set(data.catalog.filter((p) => !p.featured).map((p) => p.category))];
  const sections = grouped
    ? [
        { name: "Featured", plugins: data.catalog.filter((p) => p.featured) },
        ...groups.map((name) => ({
          name: categoryLabel(name),
          plugins: data.catalog.filter((p) => !p.featured && p.category === name),
        })),
      ].filter((s) => s.plugins.length)
    : [{ name: normalized ? "Results" : category, plugins: filtered }];
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col px-8 pb-5 max-sm:px-5", hidden && "hidden")}>
      <button
        aria-label="Your plugins"
        className="mb-5 flex h-8 shrink-0 cursor-pointer self-start items-center gap-2 rounded-lg text-left outline-none hover:opacity-70 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        onClick={onShowInstalled}
        type="button"
      >
        <span className="flex -space-x-1">
          {data.installs.slice(0, 3).map((p) => (
            <span className="rounded-[7px] ring-2 ring-background" key={p.id}>
              <PluginMark
                name={p.name}
                size="xs"
                logoUrl={
                  p.catalog?.logoUrl ?? data.catalog.find((c) => c.key === p.pluginKey)?.logoUrl
                }
              />
            </span>
          ))}
        </span>
        <span className="text-[12px] text-foreground-secondary">
          {data.installs.length ? `${data.installs.length} installed` : "Your plugins"}
        </span>
        <ChevronRight className="size-3 text-foreground-tertiary" />
      </button>
      <SearchField query={query} onChange={setQuery} />
      <MarketplaceCategories category={category} onChange={setCategory} />
      <div className="bot-scrollbar mt-7 min-h-0 flex-1 overflow-y-auto">
        {sections.map((section) => (
          <section className="mb-7" key={section.name}>
            <div className="mb-2 flex items-center justify-between px-2">
              <h3 className="text-[14px] font-medium">{section.name}</h3>
              {grouped && section.plugins.length > 6 && (
                <button
                  className="text-[12px] text-foreground-secondary hover:text-foreground"
                  onClick={() => setCategory(section.name as PluginMarketplaceCategory)}
                  type="button"
                >
                  View all
                </button>
              )}
            </div>
            <div className={cn("grid gap-x-4", grouped && "grid-cols-2 max-sm:grid-cols-1")}>
              {(grouped ? section.plugins.slice(0, 6) : section.plugins).map((plugin) => (
                <PluginRow
                  key={plugin.key}
                  plugin={plugin}
                  busy={busy === plugin.key}
                  onOpen={onOpen}
                  onInstall={onInstall}
                />
              ))}
            </div>
          </section>
        ))}
        {!filtered.length && !grouped && (
          <p className="py-12 text-center text-[13px] text-foreground-secondary">
            No plugins found.
          </p>
        )}
      </div>
    </div>
  );
}

export function InstalledPluginsView({
  data,
  busy,
  onOpen,
  onBack,
  onManage,
  onRetry,
  catalogFallback,
}: {
  data: PluginSettingsView;
  busy: string | null;
  onOpen: (plugin: PluginCatalogItemView) => void;
  onBack: () => void;
  onManage: (section?: "installed" | "private") => void;
  onRetry: (connection: PluginConnectionView) => void;
  catalogFallback: (install: PluginInstallView) => PluginCatalogItemView;
}) {
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<PluginPrivateSkillView[] | null>(null);
  const [skillError, setSkillError] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .pluginManagement()
      .then((value) => {
        if (active) setSkills(value.skills);
      })
      .catch(() => {
        if (active) setSkillError(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const matches = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());
  const installs = data.installs.filter((p) => matches(p.name));
  return (
    <div className="flex min-h-0 flex-1 flex-col px-8 pb-6 max-sm:px-5">
      <button
        onClick={onBack}
        className="mb-4 flex self-start items-center gap-1 rounded-md bg-black/[0.035] px-2 py-1 text-[12px] text-foreground-secondary dark:bg-white/[0.05]"
        type="button"
      >
        <ChevronLeft className="size-3" />
        Back to Marketplace
      </button>
      <SearchField query={query} onChange={setQuery} />
      <div className="bot-scrollbar mt-8 min-h-0 flex-1 overflow-y-auto">
        <section>
          <div className="mb-2 flex items-center justify-between px-2">
            <h3 className="text-[12px] text-foreground-secondary">Installed</h3>
            <button
              type="button"
              className="text-[12px] text-foreground-secondary hover:text-foreground"
              onClick={() => onManage("installed")}
            >
              Manage plugins
            </button>
          </div>
          <div className="grid grid-cols-2 gap-x-4 max-sm:grid-cols-1">
            {installs.map((install) => {
              const plugin =
                install.catalog ??
                data.catalog.find((p) => p.key === install.pluginKey) ??
                catalogFallback(install);
              const retry = install.connections.find((c) => c.status !== "ready");
              const connectors = new Set(install.connections.map((c) => c.connectorKey)).size;
              const subtitle = [
                connectors ? `${connectors} connector${connectors === 1 ? "" : "s"}` : "",
                plugin.skills.length
                  ? `${plugin.skills.length} skill${plugin.skills.length === 1 ? "" : "s"}`
                  : "",
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <PluginRow
                  key={install.id}
                  plugin={plugin}
                  subtitle={subtitle}
                  onOpen={onOpen}
                  action={
                    retry ? (
                      <button
                        className={pill}
                        disabled={busy === retry.id}
                        onClick={() => (retry.configured ? onRetry(retry) : onOpen(plugin))}
                        type="button"
                      >
                        {busy === retry.id ? (
                          <LoaderCircle className="size-3 animate-spin" />
                        ) : null}
                        {retry.configured ? "Retry" : "Set up"}
                      </button>
                    ) : (
                      <span />
                    )
                  }
                />
              );
            })}
          </div>
          {!installs.length && (
            <p className="px-2 py-4 text-[13px] text-foreground-secondary">
              {query ? "No installed plugins found." : "No plugins installed yet."}
            </p>
          )}
        </section>
        <section className="mt-8">
          <div className="mb-2 flex items-center justify-between px-2">
            <h3 className="text-[12px] text-foreground-secondary">Private</h3>
            <button
              className="text-[12px] text-foreground-secondary hover:text-foreground"
              type="button"
              onClick={() => onManage("private")}
            >
              Manage skills
            </button>
          </div>
          {skills
            ?.filter((s) => matches(s.name))
            .map((skill) => (
              <button
                className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-black/[0.035] dark:hover:bg-white/[0.035]"
                key={skill.id}
                onClick={() => onManage("private")}
                type="button"
              >
                <PluginMark name={skill.name} />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">{skill.name}</span>
                  <span className="block truncate text-[12px] text-foreground-secondary">
                    {skill.description}
                  </span>
                </span>
              </button>
            ))}
          {(!skills || !skills.length) && (
            <p className="px-2 text-[12px] text-foreground-secondary">
              {skillError
                ? "Could not load private skills. Open Manage skills to retry."
                : skills
                  ? "No private skills yet. Create one or ask your Bot to help."
                  : "Loading private skills…"}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
