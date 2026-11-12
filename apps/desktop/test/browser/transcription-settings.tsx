import React from "react";
import { createRoot } from "react-dom/client";
import { createOpenTeamClient } from "@openteam/client-core";
import { api } from "../../src/renderer/client/openteam-api";
import { TranscriptionSettingsPanel } from "../../src/renderer/components/openteam/settings/transcription";
import "../../src/renderer/styles.css";

const fixture = (window as any).transcriptionFixture as { baseUrl: string };
const client = createOpenTeamClient({ baseUrl: fixture.baseUrl });
api.transcriptionSettings = client.transcriptionSettings;
api.updateTranscriptionSettings = client.updateTranscriptionSettings;
api.checkTranscription = client.checkTranscription;

createRoot(document.getElementById("root")!).render(<TranscriptionSettingsPanel />);
