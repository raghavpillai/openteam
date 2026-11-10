// Production panels with synthetic data; never connect to a user's server.
import type { BotView, ChannelView, CreateBotInput, SearchResultView } from "@openteam/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/renderer/styles.css";
import { api } from "../../src/renderer/client/openteam-api";
import { NewBotDialog } from "../../src/renderer/components/openteam/new-bot-dialog";
import {
  SearchDialog,
  type SearchAction,
} from "../../src/renderer/components/openteam/search-dialog";
import { Sidebar } from "../../src/renderer/components/openteam/sidebar";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import { useSidebarPreferences } from "../../src/renderer/hooks/use-sidebar-preferences";
window.fetch = async () => {
  throw new Error("Network disabled in panel fixture");
};
const names = ["Research helper", "Writing partner", "Planning team", "Code reviewer"];
const bots = new Map(
  names.map((name, index) => [
    `bot-${index}`,
    {
      id: `bot-${index}`,
      name,
      color: "#4b8efb",
      icon: ["classic", "pod", "chip", "terminal"][index],
      status: "active",
      description: "Ready to help with your next task.",
      dmChannelId: `channel-${index}`,
    } as BotView,
  ])
);
const channels = names.map(
  (name, index) =>
    ({
      id: `channel-${index}`,
      name,
      kind: index === 2 ? "group" : "bot_dm",
      members: [{ botId: `bot-${index}` }],
      createdAt: "2026-11-01T12:00:00Z",
      updatedAt: "2026-11-01T12:00:00Z",
    }) as ChannelView
);
const documents = channels.map(
  (c, i) =>
    ({
      id: `result-${i}`,
      kind: c.kind === "group" ? "channel" : "bot",
      title: c.name,
      subtitle: "Ready to help with your next task.",
      botId: `bot-${i}`,
      channelId: c.id,
      createdAt: c.createdAt,
    }) as SearchResultView
);
type SearchProbe = { query: string; aborted: boolean };
declare global {
  interface Window {
    panelSearchLog: SearchProbe[];
  }
}
window.panelSearchLog = [];
const params = new URLSearchParams(location.search);
const stress = params.has("search-stress");
api.search = async (query, _category, signal) => {
  const probe = { query, aborted: false };
  window.panelSearchLog.push(probe);
  signal?.addEventListener(
    "abort",
    () => {
      probe.aborted = true;
    },
    { once: true }
  );
  if (!stress)
    return {
      results: documents.filter(
        (r) => !query || r.title.toLowerCase().includes(query.toLowerCase())
      ),
    };
  // Intentionally ignore abort at the transport layer: the UI must reject stale replies too.
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      query === "slow-old" || query === "close-pending" ? 280 : query === "error-probe" ? 80 : 20
    )
  );
  if (params.has("offline") || query === "error-probe")
    throw new Error("Search fixture is offline");
  const result = (kind: SearchResultView["kind"], title: string, index = 0): SearchResultView =>
    ({
      id: `probe-${kind}-${index}`,
      kind,
      title,
      subtitle: "Synthetic search result",
      channelId: `target-${kind}-${index}`,
      createdAt: "2026-11-01T12:00:00Z",
    }) as SearchResultView;
  if (query === "slow-old") return { results: [result("bot", "Slow old reply")] };
  if (query === "fast-new") return { results: [result("bot", "Fast new reply")] };
  if (query === "close-pending") return { results: [result("bot", "Closed request reply")] };
  if (query === "empty-probe") return { results: [] };
  if (query === "bulk")
    return {
      results: Array.from({ length: 120 }, (_, index) =>
        result(
          ["bot", "channel", "message", "file", "link", "routine"][
            index % 6
          ] as SearchResultView["kind"],
          `Bulk ${index.toString().padStart(3, "0")}`,
          index
        )
      ),
    };
  if (query === "long")
    return {
      results: [{ ...result("bot", "Long ".repeat(400)), subtitle: "Description ".repeat(400) }],
    };
  if (query === "日本語") return { results: [result("bot", "日本語アシスタント")] };
  if (query.includes("<img")) return { results: [result("message", query)] };
  if (query === "body-match")
    return { results: [result("message", "Server matched the message body")] };
  return {
    results: documents.filter((r) => !query || r.title.toLowerCase().includes(query.toLowerCase())),
  };
};
const noop = () => {};
function Fixture() {
  const preferences = useSidebarPreferences();
  const [search, setSearch] = useState(false);
  const [add, setAdd] = useState(false);
  const [selected, setSelected] = useState("channel-0");
  const [created, setCreated] = useState<CreateBotInput | null>(null);
  const [attempts, setAttempts] = useState<CreateBotInput[]>([]);
  const [action, setAction] = useState("");
  const actions: SearchAction[] = [
    ...(stress
      ? [
          {
            id: "theme:dark",
            title: "Theme: Dark",
            subtitle: "Appearance",
            icon: "theme-dark" as const,
            current: true,
            run: () => setAction("dark"),
          },
        ]
      : []),
    {
      id: "settings:general",
      title: "Settings: General",
      subtitle: "Settings",
      icon: "settings",
      run: () => setAction("general"),
    },
    {
      id: "settings:computer",
      title: "Settings: Computer",
      subtitle: "Settings",
      icon: "computer",
      run: () => setAction("computer"),
    },
    {
      id: "settings:updates",
      title: "Settings: Updates",
      subtitle: "Settings",
      icon: "updates",
      run: () => setAction("updates"),
    },
  ];
  return (
    <TooltipProvider>
      <main className="flex h-screen overflow-hidden bg-background text-foreground">
        <Sidebar
          channels={channels}
          botById={bots}
          latestMessageByChannel={new Map()}
          activeRunByChannel={new Map()}
          activeTaskChannelIds={new Set()}
          selectedId={selected}
          preferences={preferences}
          onPreloadSearch={noop}
          onSearch={() => setSearch(true)}
          onSelect={setSelected}
          onNewBot={() => setAdd(true)}
          onOpenPlugins={noop}
          onOpenSettings={noop}
          onBotAction={noop}
          onDeleteChannel={noop}
          onEditChannel={noop}
        />
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-[60px] items-center border-b px-5 text-sm">
            Research helper
          </header>
          <div className="flex-1 px-8 py-8 text-sm text-foreground-secondary">
            What would you like to work on?
          </div>
          <div
            className="m-4 rounded-2xl border p-4 text-sm text-foreground-secondary"
            contentEditable
            suppressContentEditableWarning
            aria-label="Message draft"
          >
            An unfinished draft stays here.
          </div>
        </section>
        {add && (
          <NewBotDialog
            onOpenChange={setAdd}
            onCreateBot={async (input) => {
              setAttempts((current) => [...current, input]);
              await new Promise((resolve) => setTimeout(resolve, 150));
              if (new URLSearchParams(location.search).has("fail") && attempts.length === 0)
                throw new Error("Fixture creation failed. Please retry.");
              setCreated(input);
            }}
          />
        )}
        <SearchDialog
          open={search}
          onOpenChange={setSearch}
          actions={actions}
          botById={bots}
          channelById={new Map(channels.map((c) => [c.id, c]))}
          onSelectResult={(r) => r.channelId && setSelected(r.channelId)}
        />
        <output id="fixture-state" hidden>
          {JSON.stringify({ selected, created, action, attempts })}
        </output>
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
