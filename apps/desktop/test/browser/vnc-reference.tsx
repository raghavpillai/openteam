import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BotView } from "@openteam/contracts";
import { signIn } from "../../src/renderer/client/auth";
import { BotScreen } from "../../src/renderer/components/openteam/bot-screen";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import "../../src/renderer/styles.css";

const fixtureBase = import.meta.env.VITE_OPENTEAM_API_URL || location.origin;

// Observe real UI input and the next remote framebuffer paint, without injecting
// input or changing noVNC's protocol. Cursor canvases are deliberately excluded.
let input: { kind: string; started: number } | null = null;
for (const kind of ["mousedown", "mouseup", "mousemove"]) document.addEventListener(kind, (event) => {
  if (!(event instanceof MouseEvent) || (kind === "mousemove" && !event.buttons)) return;
  console.log("VNC_POINTER " + JSON.stringify({ kind, x: event.clientX, y: event.clientY, buttons: event.buttons, target: (event.target as Element).tagName }));
}, true);
for (const kind of ["mousedown", "keydown", "wheel"]) document.addEventListener(kind, (event) => {
  if ((event.target as Element).closest("[data-vnc-state]")) input = { kind, started: performance.now() };
}, true);
for (const method of ["drawImage", "putImageData"] as const) {
  const original = CanvasRenderingContext2D.prototype[method];
  // Canvas methods have overloads; preserve their arguments and receiver exactly.
  (CanvasRenderingContext2D.prototype[method] as Function) = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    const result = Reflect.apply(original, this, args);
    if (input && this.canvas === document.querySelector("[data-vnc-state] canvas")) {
      const sample = { kind: input.kind, milliseconds: Math.round(performance.now() - input.started) };
      input = null;
      void fetch(fixtureBase + "/__qa/latency", { method: "POST", body: JSON.stringify(sample) });
    }
    return result;
  };
}

const config = await (await fetch(fixtureBase + "/__qa/config")).json() as { botId: string };
await signIn("qa", "fixture-only");
const bot = { id: config.botId, name: "VNC validation", status: "active" } as BotView;
function Reference() {
  const [handoff, setHandoff] = useState<{ botId: string; messageId: string } | null>({ botId: bot.id, messageId: "qa-handoff" });
  const [connection, setConnection] = useState("connecting");
  const [connections, setConnections] = useState(0);
  useEffect(() => {
    let previous = "";
    const observer = new MutationObserver(() => {
      const next = document.querySelector("[data-vnc-state]")?.getAttribute("data-vnc-state") ?? "closed";
      if (next === previous) return;
      previous = next;
      if (next !== "connected") input = null;
      setConnection(next);
      if (next === "connected") setConnections((value) => value + 1);
      console.log("VNC_STATE " + next);
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-vnc-state"] });
    return () => observer.disconnect();
  }, []);
  return <TooltipProvider>
    <div style={{ width: 320, margin: 80 }}><BotScreen bot={bot} active enabled handoff={handoff}
      onEnable={() => {}} onHandoffFinished={() => setHandoff(null)} /></div>
    <div style={{ position: "fixed", top: 8, left: 12, zIndex: 100, display: "flex", gap: 10, color: "white", background: "#202020", padding: 4 }}>
      <output>{connection}; connections: {connections}</output>
      <button type="button" onClick={() => void fetch(fixtureBase + "/__qa/disconnect", { method: "POST" })}>Interrupt connection</button>
      <button type="button" onClick={() => setHandoff({ botId: bot.id, messageId: "qa-handoff" })}>Reopen viewer</button>
    </div>
  </TooltipProvider>;
}
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Reference />);
