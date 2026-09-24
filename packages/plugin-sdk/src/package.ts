import { parseSkillMarkdown } from "./skill-markdown";
import { parsePluginRuntimeComponents } from "./runtime-components";
import { objectValue, parsePluginDefinition, safePackagePath } from "./manifest";
import { isSecretKey } from "./configuration";
import type {
  PackagePreview,
  PluginConnectorDefinition,
  PluginDefinition,
  PluginField,
} from "./types";

export const PACKAGE_MAX_BYTES = 20 * 1024 * 1024;
export const PACKAGE_MAX_FILES = 1000;

export function validatePackageFiles(files: Record<string, string>): void {
  if (Object.keys(files).length > PACKAGE_MAX_FILES) throw new Error("Package exceeds 1,000 files");
  let bytes = 0;
  for (const [path, content] of Object.entries(files)) {
    safePackagePath(path);
    if (typeof content !== "string") throw new Error("Invalid package file");
    bytes += new TextEncoder().encode(content).length;
    if (bytes > PACKAGE_MAX_BYTES) throw new Error("Package exceeds 20 MB");
    if (
      /(^|\/)(?:node_modules|\.git|\.env(?:\..*)?|credentials\.json|auth\.json)(?:\/|$)/i.test(path)
    )
      throw new Error(`Remove private or generated file before importing: ${path}`);
  }
}

function skillFromFile(path: string, text: string) {
  return {
    ...parseSkillMarkdown(text, path.split("/").at(-2) ?? "skill"),
    path: path.slice(0, -"/SKILL.md".length),
  };
}

/** Cursor packages use both package-root and manifest-relative MCP paths. */
function mcpFilePath(path: string, manifestPath: string, files: Record<string, string>): string {
  if (!path.startsWith("../")) {
    const rootPath = safePackagePath(path);
    if (files[rootPath] !== undefined) return rootPath;
  }
  if (path.startsWith("/") || /[\\\x00-\x1f:]/.test(path))
    throw new Error(`Unsafe package path: ${path}`);
  const parts = manifestPath.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error(`Unsafe package path: ${path}`);
      parts.pop();
    } else parts.push(part);
  }
  return safePackagePath(parts.join("/"));
}

export function importPackage(files: Record<string, string>): PackagePreview {
  validatePackageFiles(files);
  const manifestPath = files["plugin.json"]
    ? "plugin.json"
    : files[".cursor-plugin/plugin.json"]
      ? ".cursor-plugin/plugin.json"
      : null;
  if (!manifestPath) throw new Error("Package requires plugin.json or .cursor-plugin/plugin.json");
  const manifest = objectValue(JSON.parse(files[manifestPath]!));
  if (manifest.key && Array.isArray(manifest.connections)) {
    if (Array.isArray(manifest.skills))
      manifest.skills = manifest.skills.map((raw) => {
        const skill = objectValue(raw);
        if (skill.body !== undefined) return skill;
        const directory = safePackagePath(String(skill.path ?? `skills/${skill.name}`));
        const path = `${directory}/SKILL.md`;
        if (files[path] === undefined) throw new Error(`Missing skill file: ${path}`);
        return {
          ...skillFromFile(path, files[path]),
          ...skill,
          body: skillFromFile(path, files[path]).body,
          path: directory,
        };
      });
    const definition = parsePluginDefinition(manifest);
    definition.files = {
      ...definition.files,
      ...Object.fromEntries(Object.entries(files).filter(([path]) => path !== manifestPath)),
    };
    return {
      definition: parsePluginDefinition(definition),
      warnings: parsePluginRuntimeComponents(definition.files).warnings,
      format: "openteam",
    };
  }
  const runtimeComponents = parsePluginRuntimeComponents(files);
  const warnings = runtimeComponents.warnings;
  const variableSchema = objectValue(manifest.variables);
  const required = Array.isArray(variableSchema.required) ? variableSchema.required : [];
  const setupFields: PluginField[] = Object.entries(objectValue(variableSchema.properties)).map(
    ([key, raw]) => {
      const field = objectValue(raw);
      return {
        key,
        label: String(field.title ?? key),
        type: (field.type ?? "string") as PluginField["type"],
        required: required.includes(key),
        secret: Boolean(
          field.secret ||
            field.writeOnly ||
            ((field.type ?? "string") === "string" && isSecretKey(key))
        ),
        helpText: typeof field.description === "string" ? field.description : null,
        ...(field.default !== undefined
          ? { default: field.default as PluginField["default"] }
          : {}),
        ...(Array.isArray(field.enum)
          ? { enum: field.enum as NonNullable<PluginField["enum"]> }
          : {}),
      };
    }
  );
  const readJson = (path: string) => {
    const content = files[mcpFilePath(path, manifestPath, files)];
    if (content === undefined) throw new Error(`Missing package file: ${path}`);
    return objectValue(JSON.parse(content));
  };
  const mcpSources =
    manifest.mcpServers === undefined
      ? files["mcp.json"]
        ? ["mcp.json"]
        : files[".mcp.json"]
          ? [".mcp.json"]
          : []
      : Array.isArray(manifest.mcpServers)
        ? manifest.mcpServers
        : [manifest.mcpServers];
  const connections: PluginConnectorDefinition[] = [];
  for (const source of mcpSources) {
    const sourceObject = typeof source === "string" ? readJson(source) : objectValue(source);
    const servers = objectValue(sourceObject.mcpServers ?? sourceObject);
    for (const [key, raw] of Object.entries(servers)) {
      const server = objectValue(raw);
      const http = typeof server.url === "string";
      if (!http && typeof server.command !== "string")
        throw new Error(`MCP server ${key} needs a URL or command`);
      if (http && server.command)
        throw new Error(`MCP server ${key} cannot have both URL and command`);
      const oauthHints = { ...objectValue(server.auth), ...objectValue(server.oauth) };
      const fixedClient = ["clientId", "client_id", "CLIENT_ID"].some(
        (field) => typeof oauthHints[field] === "string" && oauthHints[field] !== ""
      );
      const hasOAuth = Boolean(
        server.oauth || fixedClient || objectValue(server.auth).type === "oauth"
      );
      if (fixedClient)
        warnings.push(
          `MCP server ${key}: configure your own OAuth client in OpenTeam. The upstream client identity and callback settings were not adopted.`
        );
      if (http && !hasOAuth && !Object.keys(objectValue(server.headers)).length)
        warnings.push(
          `MCP server ${key}: this package does not declare authentication. If the service requires sign-in, configure OAuth in the plugin definition before installing, or use its OpenTeam registry package.`
        );
      connections.push({
        key,
        name: key,
        transport: http ? "http" : "stdio",
        endpoint: http ? String(server.url) : "",
        auth: hasOAuth
          ? "oauth"
          : Object.keys(objectValue(server.headers)).length
            ? "token"
            : "none",
        configuration: http
          ? { headers: objectValue(server.headers) }
          : {
              command: server.command,
              args: server.args ?? [],
              env: server.env ?? {},
              ...(server.cwd ? { cwd: server.cwd } : {}),
            },
        tools: [],
        ...(fixedClient
          ? {
              oauth: {
                clientType: "confidential" as const,
                registration: "manual" as const,
                tokenEndpointAuthMethod: "client_secret_post" as const,
              },
              setup: {
                kind: "oauth_client" as const,
                connectionKey: key,
                title: `Connect ${key}`,
                description:
                  "Register an OAuth application for this deployment and configure its callback before signing in.",
                documentationUrl: null,
                steps: [],
                requiredScopes: [],
                fields: [
                  { key: "clientId", label: "OAuth client ID", required: true, secret: false },
                  {
                    key: "clientSecret",
                    label: "OAuth client secret",
                    required: true,
                    secret: true,
                  },
                ],
              },
            }
          : {}),
      });
    }
  }
  const skillPaths =
    manifest.skills === undefined
      ? ["skills"]
      : Array.isArray(manifest.skills)
        ? manifest.skills
        : [manifest.skills];
  const skills = Object.entries(files)
    .filter(
      ([path]) =>
        path.endsWith("/SKILL.md") &&
        skillPaths.some(
          (root) =>
            typeof root === "string" &&
            (path === root.replace(/^\.\//, "") ||
              path.startsWith(`${root.replace(/^\.\//, "").replace(/\/$/, "")}/`))
        )
    )
    .map(([path, body]) => skillFromFile(path, body));
  const name = String(manifest.name ?? "");
  const author = objectValue(manifest.author);
  const definition = parsePluginDefinition({
    schemaVersion: 1,
    key: name,
    name: manifest.displayName ?? name,
    version: manifest.version ?? "1.0.0",
    description: manifest.description ?? "",
    publisher: author.name ?? "Unknown author",
    category: "Productivity",
    featured: false,
    components: [
      ...(connections.length ? ["mcp"] : []),
      ...(skills.length ? ["skills"] : []),
      ...(["rules", "commands", "agents", "hooks"] as const).filter(
        (kind) => runtimeComponents[kind].length
      ),
    ],
    connections,
    skills,
    setupFields,
    sourceUrl: manifest.repository ?? null,
    homepageUrl: manifest.homepage ?? null,
    files,
  });
  return {
    definition,
    warnings,
    format: manifestPath.startsWith(".cursor-plugin") ? "cursor-plugin" : "agent-plugin",
  };
}

/** Export the pinned package definition, never a connection's resolved configuration. */
export function exportPackage(plugin: PluginDefinition): Record<string, string> {
  const definition = parsePluginDefinition(plugin);
  const files = { ...definition.files };
  delete definition.files;
  delete definition.binaryFiles;
  for (const skill of definition.skills) {
    const path = safePackagePath(
      skill.path ?? `skills/${skill.name.toLowerCase().replace(/[^a-z0-9.-]+/g, "-")}`
    );
    files[`${path}/SKILL.md`] =
      `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n${skill.body}\n`;
  }
  files["plugin.json"] = `${JSON.stringify(definition, null, 2)}\n`;
  validatePackageFiles(files);
  return files;
}

const stableJson = (value: unknown) =>
  JSON.stringify(value, (_key, nested) =>
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)))
      : nested
  );

export function packageChanges(previous: PluginDefinition, next: PluginDefinition): string[] {
  const changes: string[] = [];
  const old = new Map(previous.connections.map((connection) => [connection.key, connection]));
  for (const connection of next.connections) {
    const before = old.get(connection.key);
    if (!before) changes.push(`Add connector: ${connection.name}`);
    else if (stableJson(before) !== stableJson(connection))
      changes.push(
        `Change connector: ${connection.name}${before.auth !== connection.auth || before.transport !== connection.transport || before.endpoint !== connection.endpoint || stableJson(before.oauth?.authorizationServer) !== stableJson(connection.oauth?.authorizationServer) ? " (requires reconnect)" : ""}`
      );
    old.delete(connection.key);
  }
  for (const connection of old.values())
    changes.push(`Remove connector and its accounts: ${connection.name}`);
  for (const skill of next.skills) {
    const before = previous.skills.find((candidate) => candidate.name === skill.name);
    if (!before) changes.push(`Add skill: ${skill.name}`);
    else if (stableJson(before) !== stableJson(skill)) changes.push(`Change skill: ${skill.name}`);
  }
  for (const skill of previous.skills.filter(
    (skill) => !next.skills.some((candidate) => candidate.name === skill.name)
  ))
    changes.push(`Remove skill: ${skill.name}`);
  if (stableJson(previous.setupFields) !== stableJson(next.setupFields))
    changes.push("Change setup fields");
  if (
    stableJson(previous.files) !== stableJson(next.files) ||
    stableJson(previous.binaryFiles) !== stableJson(next.binaryFiles)
  )
    changes.push("Change supporting package files");
  return changes;
}
