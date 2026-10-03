import React from "react";
import { createRoot } from "react-dom/client";
import ComputerSettings from "../../src/renderer/components/openteam/settings/computer";
import "../../src/renderer/styles.css";
import { onePasswordError } from "@openteam/contracts/saved-logins";
const calls: unknown[] = [];
let state: any = {
  credentialProviders: [],
  cookieGrants: [],
  messagesGrants: [],
};
(window as any).fixtureCalls = calls;
let cancelSetup: (() => void) | undefined;
const updateProvider = (patch: Record<string, unknown>) => {
  const provider = { ...state.credentialProviders[0], ...patch };
  state = { ...state, credentialProviders: [provider] };
  return state;
};
(window as any).openteam = {
  permissions: {
    get: async () => ({ machine: { label: "Fixture computer" } }),
    getCapabilities: async () => state,
    importSavedLoginToken: async (_token: string) => {
      calls.push({ action: "import-token" });
      if ((window as any).fixtureMode === "invalid") throw new Error("Synthetic invalid token");
      if ((window as any).fixtureMode === "cancel") return new Promise((_resolve, reject) => { cancelSetup = () => reject(onePasswordError("cancelled")); });
      const provider = { account: "service-account", vault: "fixture-vault", vaultName: "Existing Work Vault", alwaysAllow: false, lifecycleState: "active", itemCount: 2 };
      state = { ...state, credentialProviders: [provider, ...((window as any).fixtureMultipleVaults ? [{ ...provider, vault: "family-vault", vaultName: "Existing Family Vault" }] : [])] };
      return state;
    },
    cancelSavedLoginSetup: async () => {
      calls.push({ action: "cancel" });
      cancelSetup?.();
    },
    setSavedLoginAlwaysAllow: async (connectionId: string, alwaysAllow: boolean) => {
      calls.push({ action: "always-allow", connectionId, alwaysAllow });
      return updateProvider({ alwaysAllow });
    },
    syncSavedLogins: async (connectionId: string) => {
      calls.push({ action: "sync", connectionId });
      return updateProvider({
        lastSyncErrorCode: (window as any).fixtureSyncFailure ? "provider-unavailable" : null,
        itemCount: 3,
      });
    },
    listSavedLogins: async () => ({
      connected: true,
      credentials: [
        {
          credential_id: "fixture-login",
          connection_id: "1password:fixture-account:fixture-vault",
          title: "Fixture login",
          sites: ["https://example.test"],
          autoFill: false,
        },
      ],
    }),
    updateCapabilities: async (input: any) => {
      calls.push({ action: "update", input });
      state = { ...state, ...input };
      if (input.removeCredentialConnection || input.revoke === "credentials")
        state = { ...state, credentialProviders: [] };
      return state;
    },
  },
};
const { api } = await import("../../src/renderer/client/openteam-api");
if (new URLSearchParams(location.search).has("marketplace")) {
  api.pluginSettings = async () => ({ catalog: [], installs: [], botCount: 1, policies: [], activity: [] });
  api.pluginManagement = async () => ({ skills: [] }) as any;
  const { PluginDialog } = await import("../../src/renderer/components/openteam/plugin-settings");
  createRoot(document.getElementById("root")!).render(<PluginDialog open onOpenChange={() => {}} />);
} else {
  api.machines = async () => [];
  api.computerDisplay = async () => ({ width: 1280, height: 800 });
  (window as any).openteam.auth = { machineStatus: async () => null };
  createRoot(document.getElementById("root")!).render(<main style={{ padding: 32, maxWidth: 760 }}><ComputerSettings /></main>);
}
