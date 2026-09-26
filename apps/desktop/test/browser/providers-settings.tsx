import React from "react";
import { createRoot } from "react-dom/client";
import { createOpenTeamClient } from "@openteam/client-core";
import { api } from "../../src/renderer/client/openteam-api";
import ProvidersSettings from "../../src/renderer/components/openteam/settings/providers";
import "../../src/renderer/styles.css";

// Real server and database; scripts/test-provider-settings.ts drives the UI.
const fixture = (window as any).providersFixture as { baseUrl: string; token?: string };
const client = createOpenTeamClient({
  baseUrl: fixture.baseUrl,
  getAuthToken: () => fixture.token,
});
api.webProviders = client.webProviders;
api.updateWebProviders = client.updateWebProviders;
api.checkWebProvider = client.checkWebProvider;
createRoot(document.getElementById("root")!).render(<ProvidersSettings />);
(window as any).providersReady = true;
