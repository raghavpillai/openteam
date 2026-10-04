import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";
import { RuntimeTools } from "../../src/runtime/tools";
import { NativeToolExecutor } from "../../src/native-tool-executor";
import { startHostBridge } from "../../../desktop/src/main/host/bridge";
import { HostCapabilities } from "../../../desktop/src/main/host/capabilities";
import { CapabilitySettingsStore } from "../../../desktop/src/main/host/capability-settings";
import { SavedCredentials } from "../../../desktop/src/main/host/credentials";
import { createComputerSettingsStore } from "../../../desktop/src/main/computer-settings";

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)(
  "real runtime → native bridge → direct private browser fill keeps values out of events and results",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "saved-login-e2e-"));
    const pageServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          '<!doctype html><form><input autocomplete="username"><input id="password" type="password"></form>',
          { headers: { "content-type": "text/html" } }
        ),
    });
    const driver = await outOfProcessPlaywright();
    const browser = await driver.playwright.chromium.launch({
      headless: true,
      executablePath: process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE,
    });
    const context = await browser.newContext();
    const session = new (BrowserUseSession as any)(browser, context, root) as BrowserUseSession;
    const settings = new CapabilitySettingsStore(join(root, "capabilities.json"));
    await settings.mutate(current => ({ ...current, credentialProviders: [{ account: "account", vault: "vault" }] }));
    const item = {
      id: "login",
      title: "Fixture login",
      category: "LOGIN",
      updated_at: "fixture-revision",
      urls: [{ href: pageServer.url.origin }],
    };
    let secretReads = 0;
    const command = async (_file: string, args: string[]) => {
      if (args[1] === "list") return JSON.stringify([item]);
      secretReads++;
      return JSON.stringify({
        ...item,
        fields: [
          { purpose: "USERNAME", value: "fixture-user" },
          { purpose: "PASSWORD", value: "SYNTHETIC-PRIVATE-VALUE" },
        ],
      });
    };
    const native = new HostCapabilities(
      settings,
      undefined,
      undefined,
      undefined,
      "darwin",
      undefined,
      command
    );
    const bridge = await startHostBridge({
      token: "fixture-control",
      hostname: "127.0.0.1",
      port: 0,
      terminalDir: join(root, "terminals"),
      computerSettings: createComputerSettingsStore(join(root, "permissions.json")),
      runJob: async () => ({}),
      capabilities: native,
    });
    const address = bridge.address();
    if (!address || typeof address === "string") throw new Error("No bridge");
    const tools = new RuntimeTools(
      {
        browserEndpointForAgent: async () => "fixture",
        withAgentBrowserInput: async (_bot: string, _cwd: string, operation: any) => operation(),
      } as any,
      "http://127.0.0.1:1",
      "fixture-control",
      root,
      root
    );
    (tools as any).nativeToolExecutor = new NativeToolExecutor({
      agentDir: root,
      controlToken: "fixture-control",
      hostBridgeUrl: `http://127.0.0.1:${address.port}`,
    });
    const botId = crypto.randomUUID();
    (tools as any).browserUseSessions.set(botId, session);
    const events: any[] = [];
    const active: any = {
      turnId: "fixture-turn",
      botId,
      screenBotId: botId,
      runId: crypto.randomUUID(),
      cwd: root,
      requestSource: "user",
      runtimeProfile: "main",
      queue: {
        push(event: any) {
          events.push(event);
        },
      },
    };
    try {
      await session.execute("browser_navigate", { url: pageServer.url.origin });
      const catalog = await new SavedCredentials(settings, command).list({
        site: pageServer.url.origin,
      });
      const { credential_id, connection_id, catalog_revision } = catalog.credentials[0]!;
      const credential = {
        credential_id,
        connection_id,
        catalog_revision,
        kind: "browser-login",
        site: pageServer.url.origin,
        purpose: "Use the synthetic fixture login",
      };
      const result = await (tools as any).executeOpenTeamTool(active, "login-call", "SendToUser", {
        type: "credential-request",
        credential,
      });
      expect(result.details.filled).toBe(true);
      expect(secretReads).toBe(1);
      expect(JSON.stringify({ events, result })).not.toContain("SYNTHETIC-PRIVATE-VALUE");
      expect(events.filter(event => event.type === "approval.action").map(event => event.status)).toEqual([]);
      expect(events.filter(event => event.type === "approval.action").every(event => event.decision === "accept")).toBe(true);
      const page = await (session as any).ensurePage();
      expect(await page.locator("#password").inputValue()).toBe("SYNTHETIC-PRIVATE-VALUE");
      // Exercise the combined worker against the session that received the private login.
      const combined = tools.customTools({ ...active, runtimeProfile: "subagent", subagentType: "computerUse",
        taskConfiguration: { combinedComputerUse: true, executorProfiles: [] } });
      expect(combined.some(tool => tool.name === "Computer")).toBe(true);
      const invokeWorker = (name: string, callId: string, args: Record<string, unknown>) =>
        (combined.find(tool => tool.name === name)!.execute as (callId: string, args: Record<string, unknown>) => Promise<unknown>)(callId, args);
      const snapshot = await invokeWorker("browser_snapshot", "worker-snapshot", {});
      expect(JSON.stringify(snapshot)).not.toContain("SYNTHETIC-PRIVATE-VALUE");
      await expect(invokeWorker("browser_cdp", "worker-private-read", {
        method: "Runtime.evaluate", params: { expression: 'btoa(document.querySelector("#password").value)', returnByValue: true },
      })).rejects.toThrow("private login data");
      await page.reload();
      secretReads = 0;
      events.length = 0;
      const fill = (session as any).fillSavedLogin.bind(session);
      (session as any).fillSavedLogin = async () => false;
      const changed = await (tools as any).executeOpenTeamTool(active, "changed-call", "SendToUser", {type:"credential-request", credential});
      expect(changed.details.filled).toBe(false);
      expect(events.filter(event => event.type === "approval.action").map(event => event.status)).toEqual([]);
      (session as any).fillSavedLogin = async () => { throw new Error("SYNTHETIC-PRIVATE-VALUE"); };
      events.length = 0; secretReads = 0;
      await expect((tools as any).executeOpenTeamTool(active, "failed-call", "SendToUser", {type:"credential-request", credential})).rejects.toThrow();
      expect(events.filter(event => event.type === "approval.action").map(event => event.status)).toEqual([]);
      expect(JSON.stringify(events)).not.toContain("SYNTHETIC-PRIVATE-VALUE");
      (session as any).fillSavedLogin = fill;
      events.length = 0; secretReads = 0;
      const direct = await (tools as any).executeOpenTeamTool(active,"legacy-deny-call","SendToUser",{type:"credential-request",credential});
      expect(direct.details.filled).toBe(true);
      expect(secretReads).toBe(1);
      expect(events.filter(event=>event.type.startsWith("approval."))).toHaveLength(0);
      expect(await page.locator("#password").inputValue()).toBe("SYNTHETIC-PRIVATE-VALUE");
    } finally {
      await browser.close();
      await driver.stop();
      pageServer.stop(true);
      await new Promise<void>((resolve) => {
        bridge.closeAllConnections();
        bridge.close(() => resolve());
      });
      await rm(root, { recursive: true, force: true });
    }
  },
  15000
);
