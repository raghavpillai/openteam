import type { PluginPackageView } from "@openteam/contracts/plugin-management";
import { Pressable, View, Text } from "react-native";
import { PluginMark } from "./plugin-mark";

import { Button, Choices } from "./plugin-controls";
import type { PluginWorkspaceModel } from "./use-plugin-workspace";
export function InstalledPackages({ model }: { model: PluginWorkspaceModel }) {
  const {
    settings,
    setPackageKey,
    packageView,
    paragraph,
    busy,
    run,
    api,
    values,
    packageKey,
    theme,
    confirm,
    exportBundle,
  } = model;
  return (
    <>
      {settings.installs.map((install) => (
        <Pressable
          key={install.id}
          accessibilityRole="button"
          onPress={() => setPackageKey(install.pluginKey)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            padding: 10,
            borderRadius: 12,
            backgroundColor: packageKey === install.pluginKey ? theme.surfacePressed : undefined,
          }}
        >
          <PluginMark
            logoUrl={
              install.catalog?.logoUrl ??
              settings.catalog.find((p) => p.key === install.pluginKey)?.logoUrl
            }
          />
          <View>
            <Text style={{ color: theme.text, fontWeight: "600" }}>{install.name}</Text>
            <Text style={{ color: theme.textMuted, fontSize: 12 }}>{install.version}</Text>
          </View>
        </Pressable>
      ))}
      {packageView && (
        <>
          {paragraph(
            `${packageView.definition.name} ${packageView.definition.version} · Skill files: ${packageView.skillSyncStatus}`
          )}
          {packageView.skillSyncError && paragraph(packageView.skillSyncError)}
          <Button
            disabled={busy}
            onPress={() => void run(() => api((client) => client.syncPluginSkills()))}
          >
            Retry skill sync
          </Button>
          <Choices
            label="Workspace policy"
            values={["optional", "default", "required", "disabled"]}
            current={packageView.mode}
            onChange={(mode) =>
              void run(() =>
                api((client) => client.setPluginMode(packageKey, mode as PluginPackageView["mode"]))
              )
            }
          />
          {paragraph(
            "Account access remains explicit. Required plugins do not automatically share your accounts."
          )}
          {packageView.update && (
            <>
              {paragraph(`Update to ${packageView.update.definition.version}`)}
              {packageView.update.changes.map((change) => (
                <Text key={change} style={{ color: theme.text }}>
                  • {change}
                </Text>
              ))}
              <Button
                disabled={busy}
                onPress={() =>
                  confirm(
                    "Apply package update",
                    "Removed connectors lose their accounts. Compatible credentials and tool preferences are retained. Reconnect after updating.",
                    () =>
                      api((client) => client.updatePlugin(packageKey, packageView.update!.digest))
                  )
                }
              >
                Apply reviewed update
              </Button>
            </>
          )}
          {packageView.hasRollback && (
            <Button
              disabled={busy}
              onPress={() => void run(() => api((client) => client.rollbackPlugin(packageKey)))}
            >
              Restore previous package
            </Button>
          )}
          <Button disabled={busy} onPress={() => void run(() => exportBundle(packageKey))}>
            Export package
          </Button>
          <Button
            disabled={busy || packageView.mode === "required"}
            onPress={() =>
              confirm(
                "Uninstall plugin",
                "Remove the installed package, all its accounts, grants and pending approvals?",
                async () => {
                  await api((client) => client.uninstallPlugin(packageKey));
                  setPackageKey("");
                }
              )
            }
          >
            Uninstall plugin
          </Button>
        </>
      )}
    </>
  );
}
