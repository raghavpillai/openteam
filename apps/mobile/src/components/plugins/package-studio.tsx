import { pluginIconUrl, type PluginTemplateMode } from "@openteam/plugin-sdk";
import { Pressable, Text } from "react-native";
import { PluginMark } from "./plugin-mark";

import { Button, Field, Choices } from "./plugin-controls";
import type { PluginWorkspaceModel } from "./use-plugin-workspace";
export function PackageStudio({ model }: { model: PluginWorkspaceModel }) {
  const {
    createDraft,
    templateMode,
    setTemplateMode,
    paragraph,
    busy,
    run,
    importFile,
    api,
    setDraftId,
    setDraftText,
    sourceUrl,
    setSourceUrl,
    management,
    draftId,
    theme,
    draftText,
    exportBundle,
    confirm,
  } = model;
  return (
    <>
      {paragraph(
        "Load a package, preview its setup, test an installation, and export a bundle for others. Drafts and installed packages are separate."
      )}
      <Button disabled={busy} onPress={() => void run(importFile)}>
        Import ZIP or manifest
      </Button>
      <Choices
        label="Plugin type"
        values={["skills", "remote-mcp", "packaged-mcp", "hybrid"]}
        current={templateMode}
        onChange={(mode) => setTemplateMode(mode as PluginTemplateMode)}
      />
      <Button disabled={busy} onPress={() => void run(createDraft)}>
        Create plugin
      </Button>
      <Field
        label="Repository / release / manifest URL"
        value={sourceUrl}
        onChange={setSourceUrl}
      />
      <Button
        disabled={busy || !sourceUrl}
        onPress={() =>
          void run(async () => {
            const draft = await api((client) => client.importPluginUrl(sourceUrl));
            setDraftId(draft.id);
            setDraftText(JSON.stringify(draft.definition, null, 2));
          })
        }
      >
        Load URL
      </Button>
      {management?.drafts.map((draft) => (
        <Pressable
          key={draft.id}
          accessibilityRole="button"
          accessibilityState={{ selected: draft.id === draftId }}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            padding: 10,
            borderRadius: 10,
            backgroundColor: draft.id === draftId ? theme.surfacePressed : "transparent",
          }}
          onPress={() => {
            setDraftId(draft.id);
            setDraftText(JSON.stringify(draft.definition, null, 2));
          }}
        >
          <PluginMark logoUrl={pluginIconUrl(draft.definition)} />
          <Text style={{ color: theme.text, flex: 1 }}>{draft.name}</Text>
        </Pressable>
      ))}
      {draftId && (
        <>
          {management?.drafts
            .find((draft) => draft.id === draftId)
            ?.warnings.map((warning) => (
              <Text key={warning} style={{ color: theme.text }}>
                {warning}
              </Text>
            ))}
          <Field
            label="Package definition (JSON)"
            value={draftText}
            onChange={setDraftText}
            multiline
          />
          <Button
            disabled={busy}
            onPress={() =>
              void run(
                () => api((client) => client.savePluginDraft(draftId, JSON.parse(draftText))),
                "Valid package saved."
              )
            }
          >
            Validate and save
          </Button>
          <Button
            disabled={busy}
            onPress={() =>
              void run(
                () => api((client) => client.installPluginDraft(draftId)),
                "Installed. Configure accounts in Connections."
              )
            }
          >
            Install for testing
          </Button>
          <Button disabled={busy} onPress={() => void run(() => exportBundle(draftId, true))}>
            Export ZIP
          </Button>
          <Button
            disabled={busy}
            onPress={() =>
              confirm("Delete draft", "Installed packages remain unchanged.", async () => {
                await api((client) => client.deletePluginDraft(draftId));
                setDraftId("");
              })
            }
          >
            Delete draft
          </Button>
        </>
      )}
    </>
  );
}
