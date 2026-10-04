import { SectionLabel, SettingsGroup, SettingsRow } from "./ui";

export function TranscriptionSettingsPanel() {
  return (
    <>
      {/* Transcription configuration is temporarily managed only on the server. */}
      <SectionLabel>Transcription</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          title="Configured on the server"
          description="Manage voice notes and transcription settings on your OpenTeam server."
        />
      </SettingsGroup>
    </>
  );
}
