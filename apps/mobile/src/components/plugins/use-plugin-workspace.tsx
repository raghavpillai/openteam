import * as Haptics from "../../haptics";
import { createPluginTemplate, type PluginTemplateMode } from "@openteam/plugin-sdk/templates";
import type { PluginSettingsView } from "@openteam/contracts";
import type {
  PluginConfigurationInput,
  PluginConfigurationView,
  PluginManagementView,
  PluginPackageView,
  PluginPrivateSkillView,
} from "@openteam/contracts/plugin-management";
import { getDocumentAsync } from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Alert, Linking, Share, Text } from "react-native";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { useOpenTeam } from "../../state/openteam-context";
import { useTheme } from "../../theme";

export interface PluginWorkspaceProps {
  settings: PluginSettingsView;
  refresh: () => Promise<unknown>;
  initialConnectionId?: string;
}
export function usePluginWorkspace({
  settings,
  refresh,
  initialConnectionId,
}: PluginWorkspaceProps) {
  const { pluginOperation: api } = useOpenTeam();
  const theme = useTheme();
  const [section, setSection] = useState("Connections");
  const [management, setManagement] = useState<PluginManagementView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [connectionId, setConnectionId] = useState(initialConnectionId ?? "");
  const [config, setConfig] = useState<PluginConfigurationView | null>(null);
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [secrets, setSecrets] = useState<NonNullable<PluginConfigurationInput["secrets"]>>({});
  const [endpoint, setEndpoint] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("[]");
  const [cwd, setCwd] = useState("");
  const [headers, setHeaders] = useState("");
  const [env, setEnv] = useState("");
  const [method, setMethod] = useState("none");
  const [alias, setAlias] = useState("");
  const [newAlias, setNewAlias] = useState("");
  const [instructions, setInstructions] = useState("");
  const [testToolName, setTestToolName] = useState("");
  const [testArguments, setTestArguments] = useState("{}");
  const [testResult, setTestResult] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [templateMode, setTemplateMode] = useState<PluginTemplateMode>("skills");
  const [draftId, setDraftId] = useState("");
  const [draftText, setDraftText] = useState("");
  const [skill, setSkill] = useState<PluginPrivateSkillView | null>(null);
  const [skillEditing, setSkillEditing] = useState(false);
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillBody, setSkillBody] = useState("");
  const [skillFiles, setSkillFiles] = useState("{}");
  const [skillBots, setSkillBots] = useState<string[]>([]);
  const [bots, setBots] = useState<Array<{ id: string; name: string }>>([]);
  const [packageKey, setPackageKey] = useState("");
  const [packageView, setPackageView] = useState<PluginPackageView | null>(null);
  const [customName, setCustomName] = useState("");
  const [customTransport, setCustomTransport] = useState("HTTP");
  const [customAuth, setCustomAuth] = useState("none");
  const allConnections = settings.installs.flatMap((install) => install.connections);
  const connection = allConnections.find((entry) => entry.id === connectionId);
  const connectionPackage = settings.installs.find(
    (install) => install.pluginKey === connection?.pluginKey
  );
  const packageRevision = connectionPackage?.packageDigest ?? connectionPackage?.version;
  const load = useCallback(async () => {
    const [next, botList] = await Promise.all([
      api((client) => client.pluginManagement()),
      api((client) => client.bots()),
    ]);
    setManagement(next);
    setBots(botList);
  }, [api]);
  const run = async (
    action: () => Promise<unknown>,
    success?: string,
    feedback: "outcome" | "error" | "none" = "outcome"
  ) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      await refresh();
      await load();
      if (success) {
        setMessage(success);
        if (feedback === "outcome") {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      }
    } catch (cause) {
      await refresh().catch(() => undefined);
      if (feedback !== "none")
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(clientErrorMessage(cause, "Plugin operation failed"));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run(load, undefined, "none");
  }, [load]);
  useEffect(() => {
    let active = true;
    setConfig(null);
    if (connectionId)
      void api((client) => client.pluginConfiguration(connectionId))
        .then((next) => {
          if (!active) return;
          setConfig(next);
          setValues(next.values);
          setSecrets({});
          setEndpoint(next.endpoint ?? "");
          setCommand(next.command ?? "");
          setArgs(JSON.stringify(next.args));
          setCwd(next.cwd ?? "");
          setMethod(next.tokenEndpointAuthMethod);
          setHeaders("");
          setEnv("");
          setAlias(connection?.alias ?? "");
          setInstructions(connection?.instructions ?? "");
        })
        .catch((cause) => {
          if (active) setError(clientErrorMessage(cause, "Plugin operation failed"));
        });
    return () => {
      active = false;
    };
  }, [api, connectionId, packageRevision]);
  useEffect(() => {
    let active = true;
    setPackageView(null);
    if (packageKey)
      void api((client) => client.pluginPackage(packageKey))
        .then((next) => {
          if (active) setPackageView(next);
        })
        .catch((cause) => {
          if (active) setError(clientErrorMessage(cause, "Plugin operation failed"));
        });
    return () => {
      active = false;
    };
  }, [api, packageKey, settings]);
  const confirm = (title: string, message: string, action: () => Promise<unknown>) =>
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Confirm", style: "destructive", onPress: () => void run(action) },
    ]);
  const saveConfig = async () => {
    await api((client) =>
      client.savePluginConfiguration(connectionId, {
        values,
        secrets,
        ...(connection?.transport === "http"
          ? { endpoint }
          : { command, args: JSON.parse(args), cwd }),
        ...(headers ? { headers: JSON.parse(headers) } : {}),
        ...(env ? { env: JSON.parse(env) } : {}),
        ...(connection?.auth === "oauth"
          ? {
              tokenEndpointAuthMethod:
                method as PluginConfigurationInput["tokenEndpointAuthMethod"],
            }
          : {}),
      })
    );
    setConfig(await api((client) => client.pluginConfiguration(connectionId)));
    setSecrets({});
    setHeaders("");
    setEnv("");
  };
  const authorize = async (force = false) => {
    await saveConfig();
    if (connection?.auth === "oauth") {
      const result = await api((client) => client.authenticatePlugin(connectionId, force));
      await Linking.openURL(result.authorizationUrl);
    } else await api((client) => client.connectPlugin(connectionId));
    setConfig(await api((client) => client.pluginConfiguration(connectionId)));
  };
  const testTool = async (confirmed = false) => {
    const result = await api((client) =>
      client.testPluginConnection(connectionId, {
        toolName: testToolName,
        arguments: JSON.parse(testArguments),
        confirmSideEffect: confirmed,
      })
    );
    setTestResult(JSON.stringify(result.result, null, 2));
  };
  const editSkill = (next: PluginPrivateSkillView | null) => {
    setSkill(next);
    setSkillName(next?.name ?? "");
    setSkillDescription(next?.description ?? "");
    setSkillBody(next?.body ?? "");
    setSkillFiles(JSON.stringify(next?.files ?? {}, null, 2));
    setSkillBots(next?.enabledBotIds ?? []);
    setSkillEditing(true);
  };
  const createDraft = async () => {
    const draft = await api((client) =>
      client.importPluginFiles({
        "plugin.json": JSON.stringify(
          createPluginTemplate(templateMode, `my-plugin-${Date.now().toString(36)}`)
        ),
      })
    );
    setDraftId(draft.id);
    setDraftText(JSON.stringify(draft.definition, null, 2));
  };
  const exportBundle = async (id: string, draft = false) => {
    const bundle = await api((client) => client.exportPlugin(id, draft));
    const file = new File(Paths.cache, bundle.filename);
    file.write(Uint8Array.from(atob(bundle.base64), (char) => char.charCodeAt(0)));
    await Share.share({ url: file.uri, title: "Export plugin package" });
  };
  const importFile = async () => {
    const result = await getDocumentAsync({
      type: ["application/zip", "application/json", "text/markdown", "text/plain"],
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const asset = result.assets[0]!;
    const file = new File(asset.uri);
    if (asset.name.endsWith(".md")) {
      editSkill(null);
      const { parseSkillMarkdown } = await import("@openteam/plugin-sdk/skill-markdown");
      const parsed = parseSkillMarkdown(await file.text(), asset.name.replace(/\.md$/, ""));
      setSkillName(parsed.name);
      setSkillDescription(parsed.description);
      setSkillBody(parsed.body);
      setSection("Private skills");
      return;
    }
    const draft = asset.name.endsWith(".zip")
      ? await api(async (client) => client.importPluginArchive(await file.bytes()))
      : await api(async (client) => client.importPluginFiles({ "plugin.json": await file.text() }));
    setDraftId(draft.id);
    setDraftText(JSON.stringify(draft.definition, null, 2));
    setSection("Develop");
  };
  const paragraph = (text: string): ReactNode => (
    <Text style={{ color: theme.textMuted, lineHeight: 20 }}>{text}</Text>
  );
  return {
    sourceId,
    setSourceId,
    createDraft,
    templateMode,
    setTemplateMode,
    settings,
    refresh,
    api,
    theme,
    section,
    setSection,
    management,
    setManagement,
    busy,
    setBusy,
    error,
    setError,
    message,
    setMessage,
    connectionId,
    setConnectionId,
    config,
    setConfig,
    values,
    setValues,
    secrets,
    setSecrets,
    endpoint,
    setEndpoint,
    command,
    setCommand,
    args,
    setArgs,
    cwd,
    setCwd,
    headers,
    setHeaders,
    env,
    setEnv,
    method,
    setMethod,
    alias,
    setAlias,
    newAlias,
    setNewAlias,
    instructions,
    setInstructions,
    testToolName,
    setTestToolName,
    testArguments,
    setTestArguments,
    testResult,
    setTestResult,
    sourceUrl,
    setSourceUrl,
    sourceName,
    setSourceName,
    draftId,
    setDraftId,
    draftText,
    setDraftText,
    skill,
    setSkill,
    skillEditing,
    setSkillEditing,
    skillName,
    setSkillName,
    skillDescription,
    setSkillDescription,
    skillBody,
    setSkillBody,
    skillFiles,
    setSkillFiles,
    skillBots,
    setSkillBots,
    bots,
    setBots,
    packageKey,
    setPackageKey,
    packageView,
    setPackageView,
    customName,
    setCustomName,
    customTransport,
    setCustomTransport,
    customAuth,
    setCustomAuth,
    allConnections,
    connection,
    load,
    run,
    confirm,
    saveConfig,
    authorize,
    testTool,
    editSkill,
    exportBundle,
    importFile,
    paragraph,
  };
}
export type PluginWorkspaceModel = ReturnType<typeof usePluginWorkspace>;
