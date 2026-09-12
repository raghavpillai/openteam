import React, { useState } from "react";
import { createOpenTeamAuthClient } from "@openteam/client-core/auth";
import { createRoot } from "react-dom/client";
import "../../src/renderer/styles.css";
import { AuthGate } from "../../src/renderer/components/openteam/auth-gate";
import { signOut } from "../../src/renderer/client/auth";

// Optional startup-only bridge failure. A later attempt uses synthetic in-memory storage.
if (new URL(window.location.href).searchParams.has("storage-error")) {
  let failRead = true;
  let token: string | null = null;
  const stored = () => ({ token, persistence: "memory", backend: "qa" });
  window.openteam = {
    versions: { app: "0.0.1" },
    updates: {
      status: async () => null,
      serverStatus: async () => null,
      onClientProgress: () => () => {},
      onServerProgress: () => () => {},
    },
    auth: {
      readToken: async () => {
        if (failRead) {
          failRead = false;
          throw new Error("Keychain unavailable: synthetic startup failure");
        }
        return stored();
      },
      writeToken: async (next: string) => {
        token = next;
        return stored();
      },
      clearToken: async () => {
        token = null;
        return stored();
      },
      signIn: (baseUrl: string, username: string, password: string) =>
        createOpenTeamAuthClient({ baseUrl }).signIn(username, password),
      signOut: (baseUrl: string, currentToken: string) =>
        createOpenTeamAuthClient({ baseUrl }).signOut(currentToken),
    },
  } as unknown as typeof window.openteam;
}

function QA() {
  const [dark, setDark] = useState(false);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  return (
    <>
      <div
        style={{
          position: "fixed",
          zIndex: 10000,
          top: 8,
          right: 10,
          display: "flex",
          gap: 12,
          font: "12px -apple-system",
          color: dark ? "white" : "black",
        }}
      >
        <span>Onboarding QA · synthetic accounts</span>
        <button onClick={() => setDark(!dark)}>{dark ? "Light" : "Dark"} appearance</button>
      </div>
      <AuthGate>
        <main style={{ padding: 100 }}>
          <h1>Signed in successfully</h1>
          <p>The auth gate reached the app.</p>
          <button onClick={() => void signOut()}>Sign out</button>
        </main>
      </AuthGate>
    </>
  );
}
const root = createRoot(document.getElementById("root")!);
import.meta.hot?.dispose(() => root.unmount());
root.render(<QA />);
