import type { BotView } from "@openteam/contracts";
import React from "react";
import { createRoot } from "react-dom/client";
import "../../src/renderer/styles.css";
import { Onboarding } from "../../src/renderer/components/openteam/onboarding";
import ServerSettings from "../../src/renderer/components/openteam/settings/server";

// Renders the first-run wizard or Settings → Server against a server (or fixture)
// behind the Vite /api proxy. ?view=settings, ?computer=down, ?offline=1, ?bots=1, ?voice=on,
// ?theme=dark, ?createFails=1. window.openteamQA.addBot(name) makes a bot "on another
// device" while the wizard is open.
const params = new URL(window.location.href).searchParams;
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
const computerDown = params.get("computer") === "down";
// Like the real server, the overall status degrades when any part is down.
const runtime = {
  server: computerDown ? "degraded" : "ready",
  database: "ready",
  queue: "ready",
  computer: computerDown ? "unavailable" : "ready",
  inference: (params.get("inference") ?? "missing") as "ready" | "missing",
  transcription: params.get("voice") === "on" ? "configured" : "missing",
} as const;

// The server check reads the runtime itself; answer it here (or fail, with ?offline=1).
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (url.pathname.endsWith("/api/v0/client-runtime")) {
    if (params.get("offline") === "1") throw new TypeError("Failed to fetch");
    return Response.json({ runtime });
  }
  return realFetch(input, init);
};

const fakeBot = (name: string, index: number): BotView =>
  ({
    id: `qa-bot-${index}`,
    name,
    icon: "chip",
    color: "#7c5cff",
    description: "Finds, compares, and summarizes information from the web, with sources.",
    dmChannelId: `qa-channel-${index}`,
  }) as BotView;

// ?createFails=N makes the first N bot creations fail, to check the retry.
let createFailures = Number(params.get("createFails") ?? 0);

function QA() {
  const [result, setResult] = React.useState<string | null>(null);
  const [bots, setBots] = React.useState<BotView[]>(() =>
    params.get("bots") === "1" ? [fakeBot("Atlas", 0)] : []
  );
  React.useEffect(() => {
    (window as unknown as { openteamQA: unknown }).openteamQA = {
      addBot: (name: string) =>
        setBots((current) => [...current, fakeBot(name, current.length + 1)]),
    };
  }, []);
  if (result) return <main style={{ padding: 60, font: "14px -apple-system" }}>{result}</main>;
  return params.get("view") === "settings" ? (
    <main className="bg-[#fcfcfc] p-8 text-foreground dark:bg-[#070707]" style={{ width: 702 }}>
      <ServerSettings />
    </main>
  ) : (
    <Onboarding
      bots={bots}
      onCreateBot={async (profile) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (createFailures > 0) {
          createFailures -= 1;
          throw new Error("The server couldn't create the bot. Try again.");
        }
        setResult(
          `Created bot: ${profile.name} · ${profile.icon} · ${profile.color} · ${profile.description}`
        );
      }}
      onFinish={() => setResult("Onboarding finished")}
      onOpenBot={async (bot) => setResult(`Opened bot: ${bot.name}`)}
      runtime={runtime}
    />
  );
}

const root = createRoot(document.getElementById("root")!);
import.meta.hot?.dispose(() => root.unmount());
root.render(<QA />);
