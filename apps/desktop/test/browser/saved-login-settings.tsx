import React from "react";
import { createRoot } from "react-dom/client";
import { NativeCapabilitySettings } from "../../src/renderer/components/openteam/settings/native-capabilities";
import "../../src/renderer/styles.css";
import { onePasswordError } from "@openteam/contracts/saved-logins";
const calls: unknown[] = [];
let state: any = {
  credentialProvider: null,
  credentialProviders: [],
  autoFill: [],
  cookieGrants: [],
  messagesGrants: [],
};
(window as any).fixtureCalls = calls;
let cancelSetup: (() => void) | undefined;
const updateProvider = (patch: Record<string, unknown>) => {
  const provider = { ...state.credentialProvider, ...patch };
  state = { ...state, credentialProvider: provider, credentialProviders: [provider] };
  return state;
};
(window as any).openteam = {
  permissions: {
    getCapabilities: async () => state,
    savedLoginAccounts: async () => [{ id: "fixture-account", label: "Fixture account" }],
    connectSavedLogins: async (input: unknown) => {
      calls.push({ action: "connect", input });
      const mode = (window as any).fixtureMode;
      if (
        mode === "permission" ||
        mode === "completion-pending" ||
        mode === "delivery-indeterminate"
      )
        throw onePasswordError(mode);
      if (mode === "cancel")
        return new Promise((_resolve, reject) => {
          cancelSetup = () => reject(onePasswordError("cancelled"));
        });
      const provider = {
        account: "fixture-account",
        vault: "fixture-vault",
        vaultName: "OpenTeam",
        broker: true,
        alwaysAllow: false,
        lifecycleState: "active",
        itemCount: 2,
        expiresAt: "2026-12-01T00:00:00.000Z",
        lastSuccessfulSyncAt: "2026-09-19T12:00:00.000Z",
      };
      state = { ...state, credentialProvider: provider, credentialProviders: [provider] };
      return state;
    },
    finishSavedLoginConnection: async () => state,
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
    restartSavedLoginSetup: async () => {},
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
        state = { ...state, credentialProvider: null, credentialProviders: [], autoFill: [] };
      return state;
    },
  },
};
createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 32, maxWidth: 760 }}>
    <NativeCapabilitySettings />
  </main>
);
