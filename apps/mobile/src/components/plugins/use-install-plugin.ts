import type { PluginCatalogItemView, PluginConnectionView } from "@openteam/contracts";
import { pluginNeedsSetup } from "@openteam/product-core/plugin-authorization";
import { Linking } from "react-native";
import { useOpenTeam } from "../../state/openteam-context";

export function useInstallPlugin(onSetup: (connection: PluginConnectionView) => void) {
  const { installPlugin, pluginSettings, authenticatePlugin, connectPlugin } = useOpenTeam();
  return async (plugin: PluginCatalogItemView, values?: Record<string, string>) => {
    await installPlugin(plugin.key, values);
    const settings = await pluginSettings();
    const connections =
      settings.installs.find((row) => row.pluginKey === plugin.key)?.connections ?? [];
    if (connections.length !== 1) return;
    const connection = connections[0]!;
    if (pluginNeedsSetup(connection, plugin)) {
      onSetup(connection);
      return;
    }
    if (connection.status === "ready") return;
    if (connection.auth === "oauth") {
      const url = await authenticatePlugin(connection.id);
      if (url) await Linking.openURL(url);
    } else await connectPlugin(connection.id);
  };
}
