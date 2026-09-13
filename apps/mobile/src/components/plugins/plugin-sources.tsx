import { Text, View } from "react-native";

import { Button, Field } from "./plugin-controls";
import type { PluginWorkspaceModel } from "./use-plugin-workspace";
export function PluginSources({ model }: { model: PluginWorkspaceModel }) {
  const {
    sourceId,
    setSourceId,
    paragraph,
    management,
    theme,
    error,
    busy,
    run,
    api,
    confirm,
    sourceName,
    setSourceName,
    sourceUrl,
    setSourceUrl,
  } = model;
  return (
    <>
      {paragraph(
        "Sources refresh without restarting your server. Removing a source keeps installed package snapshots."
      )}
      {management?.sources.map((source) => (
        <View key={source.id} style={{ gap: 8 }}>
          <Text style={{ color: theme.text }}>
            {source.name} · {source.pluginCount} plugins
          </Text>
          {paragraph(source.error ?? source.url)}
          <Button
            disabled={busy}
            onPress={() => {
              setSourceId(source.id);
              setSourceUrl(source.url);
              setSourceName(source.name);
            }}
          >
            Edit source
          </Button>
          <Button
            disabled={busy}
            onPress={() => void run(() => api((client) => client.refreshPluginSource(source.id)))}
          >
            Refresh source
          </Button>
          <Button
            disabled={busy}
            onPress={() =>
              confirm("Remove source", "Installed packages will remain available.", async () => {
                await api((client) => client.removePluginSource(source.id));
                if (sourceId === source.id) { setSourceId(""); setSourceName(""); setSourceUrl(""); }
              })
            }
          >
            Remove source
          </Button>
        </View>
      ))}
      <Field label="Source name" value={sourceName} onChange={setSourceName} />
      <Field label="Catalog manifest URL" value={sourceUrl} onChange={setSourceUrl} />
      <Button
        disabled={busy || !sourceUrl}
        onPress={() =>
          void run(() =>
            api((client) =>
              sourceId
                ? client.updatePluginSource(sourceId, sourceUrl, sourceName)
                : client.addPluginSource(sourceUrl, sourceName)
            )
          )
        }
      >
        {sourceId ? "Save source" : "Add source"}
      </Button>
    </>
  );
}
