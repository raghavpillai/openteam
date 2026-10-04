import { TranscriptionSettingsPanel } from "./transcription";
import { SectionLabel, SettingsGroup, SettingsRow } from "./ui";

export default function ServerSettings() {
  return (
    <>
      {/* Inference configuration is temporarily managed only on the server. */}
      <SectionLabel>Inference</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          anchors={["inference-provider", "inference-model", "inference-reasoning"]}
          title="Configured on the server"
          description="Manage provider connections, models, and reasoning effort on your OpenTeam server."
        />
      </SettingsGroup>
      <TranscriptionSettingsPanel />
    </>
  );
}
