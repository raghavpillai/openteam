import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { createOpenTeamClient } from "@openteam/client-core";
import {
  OPENTEAM_DEEP_LINK_EVENT,
  parseOpenTeamDeepLink,
} from "../../src/renderer/lib/app-deep-links";
import { PluginApprovalNextStep } from "../../src/renderer/components/openteam/plugins/plugin-approval-next-step";
import "../../src/renderer/styles.css";
const origin = new URLSearchParams(location.search).get("server");
if (!origin || new URL(origin).hostname !== "127.0.0.1" || window.openteam)
  throw new Error("This fixture requires a disposable local plugin test server in a browser.");
const [{ api }, { PluginDialog }, { TooltipProvider }] = await Promise.all([
  import("../../src/renderer/client/openteam-api"),
  import("../../src/renderer/components/openteam/plugin-settings"),
  import("../../src/renderer/components/ui/tooltip"),
]);
Object.assign(api, createOpenTeamClient({ baseUrl: origin }));
function Fixture() {
  const reviewPlugin = new URLSearchParams(location.search).get("reviewPlugin");
  const [open, setOpen] = useState(!reviewPlugin);
  const [target, setTarget] = useState<{ pluginId: string; nonce: number } | null>(null);
  useEffect(() => {
    const follow = (event: Event) => {
      const link = parseOpenTeamDeepLink((event as CustomEvent).detail.url);
      if (link?.kind === "plugin") {
        setTarget({ pluginId: link.pluginId, nonce: Date.now() });
        setOpen(true);
      }
    };
    window.addEventListener(OPENTEAM_DEEP_LINK_EVENT, follow);
    return () => window.removeEventListener(OPENTEAM_DEEP_LINK_EVENT, follow);
  }, []);
  return (
    <TooltipProvider>
      <button onClick={() => setOpen(true)}>Open plugins</button>
      {reviewPlugin ? (
        <PluginApprovalNextStep
          details={{ action: "InstallPlugin", arguments: { pluginKey: reviewPlugin } }}
        />
      ) : null}
      <PluginDialog open={open} onOpenChange={setOpen} target={target} />
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
