import { View, Text } from "react-native";
import { Choices } from "./plugins/plugin-controls";
import { usePluginWorkspace, type PluginWorkspaceProps } from "./plugins/use-plugin-workspace";
import { ConnectionSettings } from "./plugins/connection-settings";
import { InstalledPackages } from "./plugins/installed-packages";
import { PluginSources } from "./plugins/plugin-sources";
import { PackageStudio } from "./plugins/package-studio";
import { PrivateSkills } from "./plugins/private-skills";
import { CustomMcp } from "./plugins/custom-mcp";
export function PluginWorkspace(props: PluginWorkspaceProps) {
  const model = usePluginWorkspace(props);
  const { section, setSection, error, message, paragraph, theme } = model;
  return (
    <View style={{ gap: 16 }}>
      <Choices
        label="Plugin management"
        values={["Connections", "Packages", "Private skills", "Sources", "Develop", "Add MCP"]}
        current={section}
        onChange={setSection}
      />
      {error ? (
        <Text accessibilityRole="alert" style={{ color: theme.danger }}>
          {error}
        </Text>
      ) : null}
      {message ? paragraph(message) : null}
      {section === "Connections" && <ConnectionSettings model={model} />}
      {section === "Packages" && <InstalledPackages model={model} />}
      {section === "Sources" && <PluginSources model={model} />}
      {section === "Develop" && <PackageStudio model={model} />}
      {section === "Private skills" && <PrivateSkills model={model} />}
      {section === "Add MCP" && <CustomMcp model={model} />}
    </View>
  );
}
