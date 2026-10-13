import { createRoot } from "react-dom/client";
import { TailscaleSettings } from "../../src/renderer/components/openteam/settings/tailscale";
import "../../src/renderer/styles.css";

const calls: { action: string; httpsPort?: string }[] = [];
let enabled = false;
let fail = false;
let remote = false;
let port = "443";
(window as any).openteam = {
  tailscale: {
    request: async (request: { action: string; httpsPort?: string }) => {
      calls.push(request);
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (fail && request.action === "enable")
        throw new Error("Tailscale Serve port 443 is occupied. Choose another HTTPS port.");
      if (remote)
        return {
          canManage: false,
          status: null,
          message: "Run these commands on your OpenTeam server host.",
        };
      if (request.action === "enable") {
        enabled = true;
        port = request.httpsPort || port;
      }
      if (request.action === "disable") enabled = false;
      return {
        canManage: true,
        message: null,
        status: {
          enabled,
          publicUrl: enabled ? `https://qa.tail123.ts.net:${port}` : "http://127.0.0.1:8787",
          backendUrl: "http://127.0.0.1:8787",
          httpsPort: port,
          hostname: "qa.tail123.ts.net",
          route: enabled ? "matching" : "disabled",
          ownership: enabled ? "openteam" : "none",
          verified: enabled,
          issue: null,
          managedRoutes: enabled ? 1 : 0,
        },
      };
    },
  },
};
const root = createRoot(document.getElementById("root")!);
const render = (key: string) =>
  root.render(
    <div className="dark min-h-screen bg-background p-8 text-foreground">
      <main className="mx-auto max-w-2xl space-y-3">
        <h1 className="text-xl">Server settings</h1>
        <TailscaleSettings key={key} />
      </main>
    </div>
  );
const wait = async (check: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("UI wait timed out");
};
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === label)!;
const check = (ok: unknown, label: string) => {
  if (!ok) throw new Error(label);
};
const inputPort = (value: string) => {
  const input = document.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
(async () => {
  const reports: string[] = [];
  render("local");
  await wait(() => !!button("Enable") && !button("Enable").disabled);
  inputPort("0");
  await wait(() => button("Enable").disabled);
  inputPort("14443");
  await wait(() => !button("Enable").disabled);
  button("Enable").click();
  await wait(() => !!button("Apply / repair") && !button("Apply / repair").disabled);
  check(
    calls.some((c) => c.action === "enable" && c.httpsPort === "14443"),
    "Custom port must reach bridge"
  );
  check(document.body.textContent?.includes("HTTPS endpoint verified"), "Verified state missing");
  check(
    document.body.textContent?.includes("Reconnect your apps"),
    "Reconnect instructions missing"
  );
  reports.push("enable, custom port validation, verified state, reconnect instructions");
  fail = true;
  button("Apply / repair").click();
  await wait(() => !!document.querySelector('[role="alert"]'));
  check(
    document.body.textContent?.includes("Choose another HTTPS port"),
    "Actionable error missing"
  );
  fail = false;
  button("Disable").click();
  await wait(() => !!button("Enable") && !button("Enable").disabled);
  check(
    document.body.textContent?.includes("User-managed Serve mappings were preserved"),
    "Preservation note missing"
  );
  reports.push("failure feedback, disable, and mapping preservation notice");
  remote = true;
  render("remote");
  await wait(() => document.body.textContent?.includes("openteam tailscale enable") === true);
  check(!button("Enable"), "Remote settings must not expose local mutation controls");
  reports.push("remote host instructions without local mutation controls");
  (window as any).tailscaleSettingsResults = { reports };
  remote = false;
  enabled = true;
  render("screenshot");
})().catch((error) => {
  (window as any).tailscaleSettingsResults = { error: String(error) };
});
