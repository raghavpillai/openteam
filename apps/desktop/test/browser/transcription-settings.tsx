import React from "react";
import { createRoot } from "react-dom/client";
import { createOpenTeamClient } from "@openteam/client-core";
import { api } from "../../src/renderer/client/openteam-api";
import { TranscriptionSettingsPanel } from "../../src/renderer/components/openteam/settings/transcription";
import { SettingsPanel } from "../../src/renderer/components/openteam/settings/panel";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import "../../src/renderer/styles.css";

const fixture = (window as any).transcriptionFixture as { baseUrl: string };
const client = createOpenTeamClient({ baseUrl: fixture.baseUrl });
api.transcriptionSettings = client.transcriptionSettings;
api.updateTranscriptionSettings = client.updateTranscriptionSettings;
api.checkTranscription = client.checkTranscription;
const full = new URLSearchParams(location.search).has("full");

createRoot(document.getElementById("root")!).render(
  full ? (
    <TooltipProvider>
      <SettingsPanel open onOpenChange={() => {}} />
    </TooltipProvider>
  ) : (
    <TranscriptionSettingsPanel />
  )
);
