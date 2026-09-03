import type {
  PluginCatalogConnectionView,
  PluginCatalogItemView,
  PluginCatalogToolView,
} from "@openteam/contracts";

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
  configuration?: Readonly<Record<string, unknown>>;
  tools: PluginToolDefinition[];
}

export interface PluginDefinition
  extends Omit<
    PluginCatalogItemView,
    | "installed"
    | "connections"
    | "skills"
    | "homepageUrl"
    | "sourceUrl"
    | "sourceRevision"
    | "logoUrl"
    | "setupFields"
    | "setup"
  > {
  connections: PluginConnectorDefinition[];
  skills: PluginSkillDefinition[];
  homepageUrl?: string | null;
  sourceUrl?: string | null;
  sourceRevision?: string | null;
  logoUrl?: string | null;
  setupFields?: PluginCatalogItemView["setupFields"];
  setup?: PluginCatalogItemView["setup"];
}

const tool = (
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  risk: PluginCatalogToolView["risk"] = "read",
  defaultDecision: PluginCatalogToolView["defaultDecision"] = "allow"
) => ({ name, description, inputSchema, risk, defaultDecision });

const oauthClientFields: NonNullable<PluginCatalogItemView["setup"]>["fields"] = [
  {
    key: "clientId",
    label: "OAuth client ID",
    placeholder: "Paste the client ID",
    required: true,
    secret: false,
    helpText: null,
  },
  {
    key: "clientSecret",
    label: "OAuth client secret",
    placeholder: "Paste the client secret",
    required: true,
    secret: true,
    helpText: "Stored by your self-hosted OpenTeam server and never returned to the desktop app.",
  },
];

export const pluginCatalog: readonly PluginDefinition[] = [
  {
    key: "openteam-utility-lab",
    version: "1.0.0",
    name: "Utility Lab",
    description: "A local MCP fixture for safely testing discovery, grants, policies, and calls.",
    publisher: "OpenTeam",
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
        endpoint: "openteam://utility-lab",
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
    description:
      "Search, read, draft, and manage email with Google's Developer Preview MCP server.",
    publisher: "Google",
    category: "Inbox & Collaboration",
    featured: true,
    components: ["mcp"],
    homepageUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    setup: {
      kind: "oauth_client",
      connectionKey: "gmail",
      title: "Connect Gmail",
      description: "Create a Google OAuth web client, then authorize your Google account.",
      documentationUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
      steps: [
        "Create or select a Google Cloud project with Workspace Developer Preview access.",
        "Enable the Gmail API and Gmail MCP API, then configure the OAuth consent screen.",
        "Create a Web application OAuth client and add OpenTeam's callback URL exactly.",
      ],
      fields: oauthClientFields,
      requiredScopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ],
    },
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
    description: "Search events and schedule meetings with Google's Developer Preview MCP server.",
    publisher: "Google",
    category: "Scheduling",
    featured: true,
    components: ["mcp"],
    homepageUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    setup: {
      kind: "oauth_client",
      connectionKey: "calendar",
      title: "Connect Google Calendar",
      description: "Create a Google OAuth web client, then authorize your Google account.",
      documentationUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
      steps: [
        "Create or select a Google Cloud project with Workspace Developer Preview access.",
        "Enable the Calendar API and Calendar MCP API, then configure the OAuth consent screen.",
        "Create a Web application OAuth client and add OpenTeam's callback URL exactly.",
      ],
      fields: oauthClientFields,
      requiredScopes: [
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.events.freebusy",
        "https://www.googleapis.com/auth/calendar.events.readonly",
      ],
    },
    skills: [],
    connections: [
      {
        key: "calendar",
        name: "Google Calendar",
        transport: "http",
        auth: "oauth",
        endpoint: "https://calendarmcp.googleapis.com/mcp/v1",
        tools: [],
      },
    ],
  },
  {
    key: "google-drive",
    version: "1.0.0",
    name: "Google Drive",
    description:
      "Search, read, create, and share files with Google's Developer Preview MCP server.",
    publisher: "Google",
    category: "Documents & Files",
    featured: true,
    components: ["mcp"],
    homepageUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    setup: {
      kind: "oauth_client",
      connectionKey: "drive",
      title: "Connect Google Drive",
      description: "Create a Google OAuth web client, then authorize your Google account.",
      documentationUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
      steps: [
        "Create or select a Google Cloud project with Workspace Developer Preview access.",
        "Enable the Drive API and Drive MCP API, then configure the OAuth consent screen.",
        "Create a Web application OAuth client and add OpenTeam's callback URL exactly.",
      ],
      fields: oauthClientFields,
      requiredScopes: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/drive.file",
      ],
    },
    skills: [],
    connections: [
      {
        key: "drive",
        name: "Google Drive",
        transport: "http",
        auth: "oauth",
        endpoint: "https://drivemcp.googleapis.com/mcp/v1",
        tools: [],
      },
    ],
  },
  {
    key: "github",
    version: "1.0.0",
    name: "GitHub",
    description: "Search repositories, inspect code, manage issues, and work with pull requests.",
    publisher: "GitHub",
    category: "Agent Orchestration",
    featured: true,
    components: ["mcp"],
    homepageUrl: "https://github.com/github/github-mcp-server",
    setup: {
      kind: "token",
      connectionKey: "github",
      title: "Connect GitHub",
      description: "Paste a GitHub personal access token to connect the official remote server.",
      documentationUrl:
        "https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md",
      steps: [
        "Create a fine-grained personal access token in GitHub settings.",
        "Choose only the repositories and permissions you want OpenTeam to use.",
        "Paste the token below. OpenTeam stores it on your self-hosted server.",
      ],
      fields: [
        {
          key: "token",
          label: "Personal access token",
          placeholder: "github_pat_…",
          required: true,
          secret: true,
          helpText: "Fine-grained tokens are recommended.",
        },
      ],
      requiredScopes: [],
    },
    skills: [],
    connections: [
      {
        key: "github",
        name: "GitHub",
        transport: "http",
        auth: "token",
        endpoint: "https://api.githubcopilot.com/mcp/",
        tools: [],
      },
    ],
  },
  {
    key: "slack",
    version: "1.0.0",
    name: "Slack",
    description: "Search conversations, read threads, send messages, and work with canvases.",
    publisher: "Slack",
    category: "Inbox & Collaboration",
    featured: true,
    components: ["mcp"],
    homepageUrl: "https://docs.slack.dev/ai/slack-mcp-server",
    setup: {
      kind: "oauth_client",
      connectionKey: "slack",
      title: "Connect Slack",
      description: "Register an internal or Marketplace Slack app, then authorize a workspace.",
      documentationUrl: "https://docs.slack.dev/ai/slack-mcp-server",
      steps: [
        "Create or reuse a Slack app. Slack MCP supports internal and Marketplace apps.",
        "Add the user-token scopes needed by the Slack tools you want to use.",
        "Add OpenTeam's callback URL, then paste the app client ID and secret below.",
      ],
      fields: oauthClientFields,
      requiredScopes: [
        "search:read.public",
        "search:read.private",
        "files:read",
        "channels:history",
        "groups:history",
        "chat:write",
      ],
    },
    skills: [],
    connections: [
      {
        key: "slack",
        name: "Slack",
        transport: "http",
        auth: "oauth",
        endpoint: "https://mcp.slack.com/mcp",
        tools: [],
      },
    ],
  },
  {
    key: "notion",
    version: "1.0.0",
    name: "Notion",
    description: "Search your workspace, read pages, create documentation, and update content.",
    publisher: "Notion",
    category: "Documents & Files",
    featured: true,
    components: ["mcp"],
    homepageUrl: "https://developers.notion.com/guides/mcp/overview",
    setup: {
      kind: "oauth",
      connectionKey: "notion",
      title: "Connect Notion",
      description: "Notion registers OpenTeam during OAuth, so there are no secrets to create.",
      documentationUrl: "https://developers.notion.com/guides/mcp/build-mcp-client",
      steps: [
        "Continue to Notion's authorization page.",
        "Choose the workspace and pages OpenTeam may access.",
        "Return to OpenTeam after authorization completes.",
      ],
      fields: [],
      requiredScopes: [],
    },
    skills: [],
    connections: [
      {
        key: "notion",
        name: "Notion",
        transport: "http",
        auth: "oauth",
        endpoint: "https://mcp.notion.com/mcp",
        tools: [],
      },
    ],
  },
  {
    key: "linear",
    version: "1.0.0",
    name: "Linear",
    description: "Find, create, and update issues, projects, comments, and initiatives.",
    publisher: "Linear",
    category: "Productivity",
    featured: true,
    components: ["mcp"],
    homepageUrl: "https://linear.app/docs/mcp",
    setup: {
      kind: "oauth",
      connectionKey: "linear",
      title: "Connect Linear",
      description: "Linear registers OpenTeam during OAuth, so there are no secrets to create.",
      documentationUrl: "https://linear.app/docs/mcp",
      steps: [
        "Continue to Linear's authorization page.",
        "Choose the workspace OpenTeam may access.",
        "Return to OpenTeam after authorization completes.",
      ],
      fields: [],
      requiredScopes: [],
    },
    skills: [],
    connections: [
      {
        key: "linear",
        name: "Linear",
        transport: "http",
        auth: "oauth",
        endpoint: "https://mcp.linear.app/mcp",
        tools: [],
      },
    ],
  },
  {
    key: "atlassian",
    version: "1.0.0",
    name: "Jira & Confluence",
    description: "Search and update Jira work, Confluence pages, and Compass context.",
    publisher: "Atlassian",
    category: "Productivity",
    featured: true,
    components: ["mcp"],
    homepageUrl: "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/setting-up-clients/",
    setup: {
      kind: "oauth",
      connectionKey: "atlassian",
      title: "Connect Jira & Confluence",
      description: "Authorize OpenTeam with your Atlassian Cloud account.",
      documentationUrl:
        "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/setting-up-clients/",
      steps: [
        "Make sure your organization allows Atlassian Rovo MCP connections.",
        "Continue to Atlassian and choose the Cloud site OpenTeam may access.",
        "Return to OpenTeam after authorization completes.",
      ],
      fields: [],
      requiredScopes: [],
    },
    skills: [],
    connections: [
      {
        key: "atlassian",
        name: "Atlassian Rovo",
        transport: "http",
        auth: "oauth",
        endpoint: "https://mcp.atlassian.com/v1/mcp/authv2",
        tools: [],
      },
    ],
  },
  {
    key: "asana",
    version: "1.0.0",
    name: "Asana",
    description: "Create and manage tasks, projects, assignments, and status updates.",
    publisher: "Asana",
    category: "Productivity",
    featured: true,
    components: ["mcp"],
    homepageUrl: "https://developers.asana.com/docs/using-asanas-mcp-server",
    setup: {
      kind: "oauth_client",
      connectionKey: "asana",
      title: "Connect Asana",
      description: "Create an Asana MCP app, then authorize your workspace.",
      documentationUrl: "https://developers.asana.com/docs/integrating-with-asanas-mcp-server",
      steps: [
        "Create an app in Asana's developer console and select MCP app as its type.",
        "Add OpenTeam's callback URL and allow the workspace you want to use.",
        "Paste the app client ID and secret below, then authorize Asana.",
      ],
      fields: oauthClientFields,
      requiredScopes: [],
    },
    skills: [],
    connections: [
      {
        key: "asana",
        name: "Asana",
        transport: "http",
        auth: "oauth",
        endpoint: "https://mcp.asana.com/v2/mcp",
        tools: [],
      },
    ],
  },
  {
    key: "research-playbook",
    version: "1.0.0",
    name: "Research Playbook",
    description: "A reusable skill for source-led research and evidence synthesis.",
    publisher: "OpenTeam",
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
      if (connector.transport === "builtin" && !connector.endpoint.startsWith("openteam://")) {
        throw new Error(`Builtin connector must use openteam://: ${plugin.key}/${connector.key}`);
      }
      if (connector.transport === "http" && !connector.endpoint.startsWith("https://")) {
        throw new Error(`Remote connector must use HTTPS: ${plugin.key}/${connector.key}`);
      }
    }
    if (plugin.setup?.connectionKey && !connectorKeys.has(plugin.setup.connectionKey)) {
      throw new Error(`Plugin setup references an unknown connector: ${plugin.key}`);
    }
    if (
      plugin.setup?.kind === "token" &&
      !plugin.setup.fields.some((field) => field.key === "token")
    ) {
      throw new Error(`Token setup must declare a token field: ${plugin.key}`);
    }
    if (
      plugin.setup?.kind === "oauth_client" &&
      !plugin.setup.fields.some((field) => field.key === "clientId")
    ) {
      throw new Error(`OAuth client setup must declare a client ID field: ${plugin.key}`);
    }
  }
};

validatePluginCatalog(pluginCatalog);
