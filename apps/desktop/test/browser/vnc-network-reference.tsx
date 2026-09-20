import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ScreenVncSessionView } from "@openteam/contracts";
import VncComputer from "../../src/renderer/components/openteam/vnc-computer";
import "../../src/renderer/styles.css";

// Only the disposable network QA runner provides this bridge. No credentials
// are embedded in source, asset files, URLs, or validation logs.
declare global { interface Window { vncNetworkQA: { base: string; token: string; botId: string; label: string } } }
const config = window.vncNetworkQA;
const createSession = async (botId: string, signal: AbortSignal): Promise<ScreenVncSessionView> => {
  const response = await fetch(`${config.base}/api/v0/bots/${encodeURIComponent(botId)}/screen/vnc`, {
    method: "POST", signal, headers: { authorization: `Bearer ${config.token}` },
  });
  if (!response.ok) throw Object.assign(new Error("VNC session request failed"), { status: response.status });
  return response.json();
};
function Reference() {
  const [open, setOpen] = useState(true);
  const [connections, setConnections] = useState(0);
  const ready = useCallback(() => { setConnections(n => n + 1); console.log("VNC_NETWORK_CONNECTED " + config.label); }, []);
  return <div style={{ height: "100vh", background: "#161616", color: "white" }}>
    <div style={{ height: 50, padding: 12 }}>{config.label}: {connections} successful connections
      <button onClick={() => setOpen(!open)} style={{ marginLeft: 20 }}>{open ? "Close viewer" : "Reopen viewer"}</button>
    </div>
    <div style={{ position: "relative", height: "calc(100vh - 50px)" }}>
      {open && <VncComputer botId={config.botId} name={config.label} serverUrl={config.base}
        createSession={createSession} onReady={ready} onClose={() => setOpen(false)} />}
    </div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Reference />);
