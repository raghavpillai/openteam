import { isSecretKey } from "./configuration";
import { desktopMcpProvider } from "./desktop-runtime";
import { PLUGIN_ICON_MAX_BASE64_LENGTH } from "./icons";
import type { PluginDefinition, PluginField } from "./types";

export const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const safePackagePath = (path: string): string => {
  const normalized = path.replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.length > 512 ||
    normalized.startsWith("/") ||
    /[\\\x00-\x1f:]/.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`Unsafe package path: ${path}`);
  return normalized;
};
const identifier = /^[a-z0-9](?:[a-z0-9.-]{0,158}[a-z0-9])?$/;
const requireText = (value: unknown, label: string, limit = 20_000): void => {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new Error(`Invalid ${label}`);
};
const validateFields = (fields: readonly PluginField[]): void => {
  const keys = new Set<string>();
  for (const field of fields) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.key) || keys.has(field.key))
      throw new Error(`Invalid or duplicate setup field: ${field.key}`);
    keys.add(field.key);
    requireText(field.label, "setup field label", 200);
    if (typeof field.required !== "boolean" || typeof field.secret !== "boolean")
      throw new Error(`Invalid setup field flags: ${field.key}`);
    if (field.type && !["string", "number", "integer", "boolean"].includes(field.type))
      throw new Error(`Unsupported setup field type: ${field.key}`);
    if (
      (field.type ?? "string") === "string" &&
      isSecretKey(field.key) &&
      field.key !== "tokenEndpointAuthMethod" &&
      !field.secret
    )
      throw new Error(`Credential setup fields must use secret: true: ${field.key}`);
    if (field.secret && field.default !== undefined)
      throw new Error(`Secret defaults are not allowed: ${field.key}`);
    if (
      field.enum &&
      (!Array.isArray(field.enum) ||
        !field.enum.length ||
        field.enum.some((value) => !["string", "number", "boolean"].includes(typeof value)))
    )
      throw new Error(`Invalid options: ${field.key}`);
  }
};

export function parsePluginDefinition(value: unknown): PluginDefinition {
  const plugin = objectValue(value) as unknown as PluginDefinition;
  if (!identifier.test(plugin.key ?? "")) throw new Error(`Invalid plugin key: ${plugin.key}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(plugin.version ?? ""))
    throw new Error(`Invalid plugin version: ${plugin.key}@${plugin.version}`);
  if (plugin.schemaVersion !== undefined && plugin.schemaVersion !== 1)
    throw new Error("Unsupported plugin schema version");
  requireText(plugin.name, "plugin name", 200);
  requireText(plugin.publisher, "plugin publisher", 200);
  if (plugin.icon != null) {
    if (typeof plugin.icon !== "string" || !/\.(png|jpe?g|webp)$/i.test(plugin.icon))
      throw new Error("Plugin icon must be a package PNG, JPEG or WebP file");
    safePackagePath(plugin.icon);
    if (plugin.binaryFiles && !plugin.binaryFiles[plugin.icon])
      throw new Error(`Missing plugin icon: ${plugin.icon}`);
    if ((plugin.binaryFiles?.[plugin.icon]?.length ?? 0) > PLUGIN_ICON_MAX_BASE64_LENGTH)
      throw new Error("Plugin icon exceeds 256 KB");
  }
  if (
    typeof plugin.description !== "string" ||
    typeof plugin.category !== "string" ||
    typeof plugin.featured !== "boolean"
  )
    throw new Error("Invalid plugin metadata");
  if (
    !Array.isArray(plugin.connections) ||
    !Array.isArray(plugin.skills) ||
    !Array.isArray(plugin.components)
  )
    throw new Error("Plugin must declare connections, skills, and components");
  if (plugin.connections.length > 50 || plugin.skills.length > 200)
    throw new Error("Package has too many components");
  if (plugin.components.some((kind) => !["mcp", "skills", "rules", "commands", "agents", "hooks"].includes(kind)))
    throw new Error("Unsupported plugin component");
  if (plugin.connections.length && !plugin.components.includes("mcp"))
    throw new Error("Connector package must declare mcp component");
  if (plugin.skills.length && !plugin.components.includes("skills"))
    throw new Error("Skill package must declare skills component");
  const connectorKeys = new Set<string>();
  for (const connector of plugin.connections) {
    if (connectorKeys.has(connector.key))
      throw new Error(`Duplicate connector key: ${plugin.key}/${connector.key}`);
    if (!identifier.test(connector.key ?? "")) throw new Error("Invalid connector key");
    connectorKeys.add(connector.key);
    requireText(connector.name, "connector name", 200);
    if (
      !["http", "stdio", "builtin"].includes(connector.transport) ||
      !["none", "oauth", "token"].includes(connector.auth)
    )
      throw new Error("Unsupported connector transport or authentication");
    if (connector.transport === "http" && !/^https?:\/\//.test(connector.endpoint))
      throw new Error("MCP URL must use HTTP or HTTPS");
    if (connector.transport === "http") {
      const endpoint = new URL(
        connector.endpoint.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "placeholder")
      );
      if (endpoint.username || endpoint.password)
        throw new Error("MCP URL must not embed credentials");
      for (const [key, value] of endpoint.searchParams)
        if (isSecretKey(key) && value && value !== "placeholder")
          throw new Error("Use setup fields for URL credentials");
    }
    const inspectSecrets = (value: unknown, key = "") => {
      if (
        typeof value === "string" &&
        value &&
        isSecretKey(key) &&
        key !== "tokenEndpointAuthMethod" &&
        !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)
      )
        throw new Error(`Use a setup field instead of a literal secret: ${key}`);
      if (value && typeof value === "object")
        for (const [nestedKey, nested] of Object.entries(value)) inspectSecrets(nested, nestedKey);
    };
    inspectSecrets(connector.configuration);
    if (connector.transport === "builtin" && connector.endpoint !== "openteam://utility-lab")
      throw new Error("Unknown builtin connector");
    if (connector.transport === "stdio" && typeof connector.configuration?.command !== "string")
      throw new Error("Local MCP connector must declare a command");
    const desktopProvider = desktopMcpProvider(connector.configuration);
    if (desktopProvider && (connector.transport !== "stdio" || connector.auth !== "none"))
      throw new Error("Desktop MCP providers use stdio and authenticate in their desktop app");
    if (connector.oauth?.supportsLoopbackRedirect !== undefined && typeof connector.oauth.supportsLoopbackRedirect !== "boolean")
      throw new Error("Invalid OAuth loopback redirect support");
    if (connector.transport === "stdio" && connector.auth === "oauth") {
      const oauth = connector.oauth;
      if (!oauth?.authorizationServer || oauth.registration !== "manual")
        throw new Error("Packaged OAuth requires a manual client and authorization server");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(oauth.accessTokenEnv ?? ""))
        throw new Error("Packaged OAuth requires an access token environment variable");
      for (const value of Object.values(oauth.authorizationServer)) {
        const url = new URL(value);
        if (
          (url.protocol !== "https:" &&
            !(
              url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
            )) ||
          url.username ||
          url.password ||
          url.hash
        )
          throw new Error("OAuth endpoints must use HTTPS (or loopback HTTP) without credentials");
      }
      for (const key of ["issuer", "authorizationUrl", "tokenUrl"] as const)
        requireText(oauth.authorizationServer[key], `OAuth ${key}`);
    }
    if (!Array.isArray(connector.tools))
      throw new Error(
        "Connector must declare tools (an empty array discovers them at connection time)"
      );
    const tools = new Set<string>();
    for (const tool of connector.tools) {
      requireText(tool.name, "tool name", 200);
      if (tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
      tools.add(tool.name);
      if (
        !["read", "write", "destructive"].includes(tool.risk) ||
        !["deny", "prompt", "allow"].includes(tool.defaultDecision)
      )
        throw new Error(`Invalid tool policy: ${tool.name}`);
      if (!Object.keys(objectValue(tool.inputSchema)).length)
        throw new Error(`Tool schema is required: ${tool.name}`);
    }
  }
  const skills = new Set<string>();
  for (const skill of plugin.skills) {
    requireText(skill.name, "skill name", 200);
    if (skills.has(skill.name)) throw new Error(`Duplicate skill: ${skill.name}`);
    skills.add(skill.name);
    if (
      typeof skill.body !== "string" ||
      skill.body.length > 1_000_000 ||
      typeof skill.description !== "string"
    )
      throw new Error("Invalid skill content");
    if (skill.path) safePackagePath(skill.path);
  }
  if (plugin.installationSteps !== undefined) {
    if (!Array.isArray(plugin.installationSteps) || plugin.installationSteps.length > 30) throw new Error("Invalid installation instructions");
    for (const step of plugin.installationSteps) requireText(step, "installation step", 4000);
  }
  validateFields(plugin.setupFields ?? []);
  for (const setup of [plugin.setup, ...plugin.connections.map((connection) => connection.setup)]) {
    if (!setup) continue;
    if (setup.connectionKey && !connectorKeys.has(setup.connectionKey))
      throw new Error(`Plugin setup references an unknown connector: ${plugin.key}`);
    if (
      !Array.isArray(setup.fields) ||
      !Array.isArray(setup.steps) ||
      !Array.isArray(setup.requiredScopes)
    )
      throw new Error("Invalid setup instructions");
    for (const step of setup.steps) requireText(step, "provider setup step", 4000);
    validateFields(setup.fields);
    if (setup.kind === "token" && !setup.fields.some((field) => field.key === "token"))
      throw new Error(`Token setup must declare a token field: ${plugin.key}`);
    if (setup.kind === "oauth_client" && !setup.fields.some((field) => field.key === "clientId"))
      throw new Error(`OAuth client setup must declare a client ID field: ${plugin.key}`);
  }
  let total = new TextEncoder().encode(
    JSON.stringify({ ...plugin, files: undefined, binaryFiles: undefined })
  ).length;
  const paths = new Set<string>();
  for (const [binary, files] of [
    [false, plugin.files],
    [true, plugin.binaryFiles],
  ] as const)
    for (const [path, content] of Object.entries(files ?? {})) {
      safePackagePath(path);
      if (paths.has(path)) throw new Error(`Duplicate package file: ${path}`);
      paths.add(path);
      if (
        /(^|\/)(?:node_modules|\.git|\.env(?:\..*)?|credentials\.json|auth\.json)(?:\/|$)/i.test(
          path
        )
      )
        throw new Error(`Remove private or generated file before importing: ${path}`);
      if (typeof content !== "string") throw new Error("Package file must be text or base64");
      if (binary && (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)))
        throw new Error(`Invalid binary file encoding: ${path}`);
      total += binary ? (content.length * 3) / 4 : new TextEncoder().encode(content).length;
    }
  if (paths.size > 1000 || total > 20 * 1024 * 1024)
    throw new Error("Package exceeds its 20 MB or 1,000 file limit");
  return structuredClone(plugin);
}

export function validatePluginCatalog(catalog: readonly PluginDefinition[]): void {
  const keys = new Set<string>();
  for (const candidate of catalog) {
    const plugin = parsePluginDefinition(candidate);
    if (keys.has(plugin.key)) throw new Error(`Duplicate plugin key: ${plugin.key}`);
    keys.add(plugin.key);
  }
}
