import type { BotView } from "@openteam/contracts";
import React from "react";
import { createRoot } from "react-dom/client";
import "../../src/renderer/styles.css";
import { Onboarding } from "../../src/renderer/components/openteam/onboarding";

// The first-run wizard against a server (or fixture) behind the Vite /api proxy. ?theme=dark,
// ?createFails=N fails the first N bot creations; window.openteamQA.addBot(name) makes a bot
// "on another device" while the wizard is open.
const params = new URL(window.location.href).searchParams;
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
const runtime = { server: "ready", database: "ready", queue: "ready", computer: "ready", inference: "missing", transcription: "missing" } as const;

// The server check reads the runtime itself; answer it here.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (url.pathname.endsWith("/api/v0/client-runtime")) return Response.json({ runtime });
  return realFetch(input, init);
};

const fakeBot = (name: string, index: number) =>
  ({ id: `qa-bot-${index}`, name, icon: "chip", color: "#7c5cff", description: "Finds and summarizes information.", dmChannelId: `qa-channel-${index}` }) as BotView;
let createFailures = Number(params.get("createFails") ?? 0);

function QA() {
  const [result, setResult] = React.useState<string | null>(null);
  const [bots, setBots] = React.useState<BotView[]>([]);
  React.useEffect(() => {
    (window as unknown as { openteamQA: unknown }).openteamQA = {
      addBot: (name: string) => setBots((current) => [...current, fakeBot(name, current.length + 1)]),
    };
  }, []);
  if (result) return <main style={{ padding: 60, font: "14px -apple-system" }}>{result}</main>;
  return (
    <Onboarding
      bots={bots}
      onCreateBot={async (profile) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (createFailures-- > 0) throw new Error("The server couldn't create the bot. Try again.");
        setResult(`Created bot: ${profile.name}`);
      }}
      onFinish={() => setResult("Onboarding finished")}
      onOpenBot={async (bot) => setResult(`Opened bot: ${bot.name}`)}
      runtime={runtime}
    />
  );
}

createRoot(document.getElementById("root")!).render(<QA />);
