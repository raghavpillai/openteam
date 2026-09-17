import React from "react";
import { createRoot } from "react-dom/client";
import { NativeCapabilitySettings } from "../../src/renderer/components/openteam/settings/native-capabilities";
import "../../src/renderer/styles.css";
const calls: unknown[] = [];
let state: any = {
  credentialProvider: null,
  credentialProviders: [],
  autoFill: [],
  cookieGrants: [],
  messagesGrants: [],
};
(window as any).fixtureCalls = calls;
(window as any).openteam = {
  permissions: {
    getCapabilities: async () => state,
    savedLoginAccounts: async () => [{ id: "fixture-account", label: "Fixture account" }],
    connectSavedLogins: async (input: unknown) => {
      calls.push({ action: "connect", input });
      const provider = {
        account: "fixture-account",
        vault: "fixture-vault",
        vaultName: "OpenTeam",
        broker: true,
      };
      state = { ...state, credentialProvider: provider, credentialProviders: [provider] };
      return state;
    },
    finishSavedLoginConnection: async () => state,
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
