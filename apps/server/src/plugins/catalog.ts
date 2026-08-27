import type {
  PluginCatalogConnectionView,
  PluginCatalogItemView,
  PluginCatalogToolView,
} from "@openbot/contracts";

export interface PluginSkillDefinition {
  name: string;
  description: string;
  body: string;
}

export interface PluginToolDefinition extends PluginCatalogToolView {
  inputSchema: Readonly<Record<string, unknown>>;
}

export interface PluginConnectorDefinition extends Omit<PluginCatalogConnectionView, "tools"> {
  endpoint: string;
  tools: PluginToolDefinition[];
}

export interface PluginDefinition
  extends Omit<PluginCatalogItemView, "installed" | "connections" | "skills"> {
  connections: PluginConnectorDefinition[];
  skills: PluginSkillDefinition[];
}

const tool = (
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  risk: PluginCatalogToolView["risk"] = "read",
  defaultDecision: PluginCatalogToolView["defaultDecision"] = "allow"
) => ({ name, description, inputSchema, risk, defaultDecision });

export const pluginCatalog: readonly PluginDefinition[] = [
  {
    key: "openbot-utility-lab",
    version: "1.0.0",
    name: "Utility Lab",
    description: "A local MCP fixture for safely testing discovery, grants, policies, and calls.",
    publisher: "OpenBot",
    category: "Developer Tools",
    featured: true,
    components: ["mcp"],
    skills: [],
    connections: [
      {
        key: "utility",
        name: "Utility Lab",
        transport: "builtin",
        auth: "none",
        endpoint: "openbot://utility-lab",
        tools: [
          tool("echo", "Echo text through the complete plugin tool pipeline.", {
            type: "object",
            properties: { text: { type: "string", maxLength: 10_000 } },
            required: ["text"],
            additionalProperties: false,
          }),
          tool("add", "Add two finite numbers.", {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
            additionalProperties: false,
          }),
          tool(
            "remember_note",
            "Record a short test note in the plugin activity log.",
            {
              type: "object",
              properties: { note: { type: "string", maxLength: 2_000 } },
              required: ["note"],
              additionalProperties: false,
            },
            "write",
            "prompt"
          ),
        ],
      },
    ],
  },
  {
    key: "gmail",
    version: "1.0.0",
    name: "Gmail",
    description: "Search, read, draft, and manage email.",
    publisher: "Google",
    category: "Inbox & Collaboration",
    featured: true,
    components: ["mcp"],
    skills: [],
    connections: [
      {
        key: "gmail",
        name: "Gmail",
        transport: "http",
        auth: "oauth",
        endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
        tools: [],
      },
    ],
  },
  {
    key: "google-calendar",
    version: "1.0.0",
    name: "Google Calendar",
    description: "Search events and schedule meetings.",
    publisher: "Google",
    category: "Scheduling",
    featured: true,
    components: ["mcp"],
    skills: [],
    connections: [
      {
        key: "calendar",
        name: "Google Calendar",
        transport: "http",
        auth: "oauth",
        endpoint: "https://calendar.mcp.google.com/mcp",
        tools: [],
      },
    ],
  },
  {
    key: "google-drive",
    version: "1.0.0",
    name: "Google Drive",
    description: "Search, read, create, and share files.",
    publisher: "Google",
    category: "Documents & Files",
    featured: true,
    components: ["mcp"],
    skills: [],
    connections: [
      {
        key: "drive",
        name: "Google Drive",
        transport: "http",
        auth: "oauth",
        endpoint: "https://drive.mcp.google.com/mcp",
        tools: [],
      },
    ],
  },
  {
    key: "research-playbook",
    version: "1.0.0",
    name: "Research Playbook",
    description: "A reusable skill for source-led research and evidence synthesis.",
    publisher: "OpenBot",
    category: "Research",
    featured: false,
    components: ["skills"],
    connections: [],
    skills: [
      {
        name: "source-led-research",
        description: "Research claims against primary sources and state uncertainty clearly.",
        body: [
          "Use primary sources wherever they exist.",
          "Separate sourced facts from inference.",
          "For changing claims, verify the current state before answering.",
          "Cite the exact source supporting each material conclusion.",
        ].join("\n"),
      },
    ],
  },
] as const;

export const pluginDefinition = (pluginKey: string): PluginDefinition | undefined =>
  pluginCatalog.find((plugin) => plugin.key === pluginKey);

export const validatePluginCatalog = (catalog: readonly PluginDefinition[]): void => {
  const keys = new Set<string>();
  for (const plugin of catalog) {
    if (!/^[a-z0-9][a-z0-9-]{1,158}[a-z0-9]$/.test(plugin.key)) {
      throw new Error(`Invalid plugin key: ${plugin.key}`);
    }
    if (keys.has(plugin.key)) throw new Error(`Duplicate plugin key: ${plugin.key}`);
    keys.add(plugin.key);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(plugin.version)) {
      throw new Error(`Invalid plugin version: ${plugin.key}@${plugin.version}`);
    }
    const connectorKeys = new Set<string>();
    for (const connector of plugin.connections) {
      if (connectorKeys.has(connector.key)) {
        throw new Error(`Duplicate connector key: ${plugin.key}/${connector.key}`);
      }
      connectorKeys.add(connector.key);
      if (connector.transport === "builtin" && !connector.endpoint.startsWith("openbot://")) {
        throw new Error(`Builtin connector must use openbot://: ${plugin.key}/${connector.key}`);
      }
      if (connector.transport === "http" && !connector.endpoint.startsWith("https://")) {
        throw new Error(`Remote connector must use HTTPS: ${plugin.key}/${connector.key}`);
      }
    }
  }
};

validatePluginCatalog(pluginCatalog);
