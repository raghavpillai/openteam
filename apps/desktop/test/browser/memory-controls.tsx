import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BotMemoryEntry, BotView } from "@openteam/contracts";
import "../../src/renderer/styles.css";
import { refreshMemoryViews } from "../../src/renderer/lib/memory-events";

if (window.openteam) throw new Error("Use an isolated synthetic fixture window");
let offline = false;
const facts: Record<string, BotMemoryEntry[]> = {
  a: [
    {
      id: "0000000000000001",
      content: "For LANTERN, use metric units and start reports with the next action.",
      createdAt: Date.UTC(2026, 8, 14),
      kind: "profile",
    },
    {
      id: "0000000000000002",
      content: "[episode] The LANTERN rehearsal moved to Tuesday. Mira owns the release checklist.",
      createdAt: Date.UTC(2026, 8, 14),
      kind: "log",
    },
  ],
  b: [],
};
window.fetch = async (input, init) => {
  if (offline) throw new Error("Synthetic offline state");
  const path = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  ).pathname;
  const match = path.match(/^\/api\/v0\/bots\/(a|b)\/memories(?:\/([^/]+))?$/);
  if (!match) throw new Error("No external requests allowed in this fixture");
  const id = match[1]!;
  if (init?.method === "DELETE")
    facts[id] = match[2] ? facts[id]!.filter((fact) => fact.id !== match[2]) : [];
  return Response.json({ botId: id, memories: facts[id], total: facts[id]!.length, limit: 1000 });
};
const { BotMemoryButton } = await import("../../src/renderer/components/openteam/bot-memory");

function Fixture() {
  const [id, setId] = useState("a");
  const [disconnected, setDisconnected] = useState(false);
  const [dark, setDark] = useState(false);
  const add = () => {
    facts[id]!.push({
      id: String(Date.now()).padStart(16, "0"),
      content: "A background turn saved the calibration key: JADE-4628.",
      createdAt: Date.UTC(2026, 8, 14),
      kind: "log",
    });
    refreshMemoryViews({
      sequence: "1",
      topic: "memory.changed",
      entityId: id,
      payload: { botId: id },
      createdAt: new Date().toISOString(),
    });
  };
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="text-xl font-semibold">Synthetic memory controls</h1>
        <p className="text-sm text-muted-foreground">
          Isolated UI fixture. No real bots or network data.
        </p>
        <div className="flex flex-wrap gap-3 text-sm">
          <button onClick={() => setTimeout(add, 3000)}>Save in background in 3 seconds</button>
          <button
            onClick={() => {
              offline = !offline;
              setDisconnected(offline);
            }}
          >
            Network: {disconnected ? "offline" : "online"}
          </button>
          <button onClick={() => refreshMemoryViews()}>Reconnect</button>
          <button onClick={() => setId(id === "a" ? "b" : "a")}>Switch bot</button>
          <button
            onClick={() => {
              setDark(!dark);
              document.documentElement.dataset.theme = dark ? "light" : "dark";
            }}
          >
            Theme
          </button>
        </div>
        <BotMemoryButton
          key={id}
          bot={{ id, name: id === "a" ? "LANTERN" : "Clean bot", status: "active" } as BotView}
          active
        />
      </div>
    </main>
  );
}
const root = createRoot(document.getElementById("root")!);
import.meta.hot?.dispose(() => root.unmount());
root.render(
  <StrictMode>
    <Fixture />
  </StrictMode>
);
