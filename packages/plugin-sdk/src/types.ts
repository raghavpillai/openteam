/** Portable package definitions. These types never depend on a client, database, or runtime. */
export type ToolDecision = "deny" | "prompt" | "allow";
export type ConfigValue = string | number | boolean;
export interface PluginField {
  key: string;
  label: string;
  type?: "string" | "number" | "integer" | "boolean";
  required: boolean;
  secret: boolean;
  default?: ConfigValue;
  enum?: ConfigValue[];
  placeholder?: string;
  helpText?: string | null;
}
export interface PluginSetup {
  kind: "none" | "token" | "oauth" | "oauth_client";
  connectionKey: string | null;
  title: string;
  description: string;
  documentationUrl: string | null;
  dashboardUrl?: string | null;
  steps: string[];
  fields: PluginField[];
  requiredScopes: string[];
}
export interface PluginSkillDefinition {
  name: string;
  description: string;
  body: string;
  /** Package-relative directory; files retain their paths within this directory. */
  path?: string;
}
export interface PluginToolDefinition {
  name: string;
  description: string;
  risk: "read" | "write" | "destructive";
  defaultDecision: ToolDecision;
  inputSchema: Readonly<Record<string, unknown>>;
}
export interface PluginConnectorDefinition {
  key: string;
  name: string;
  transport: "http" | "stdio" | "builtin";
  auth: "none" | "oauth" | "token";
  endpoint: string;
  configuration?: Readonly<Record<string, unknown>>;
  tools: PluginToolDefinition[];
  setup?: PluginSetup;
  oauth?: {
    clientType: "public" | "confidential";
    registration?: "dynamic" | "manual";
    tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
    shareClientCredentials?: boolean;
    /** OAuth for packaged MCP servers. The host keeps refresh tokens and client secrets. */
    authorizationServer?: {
      issuer: string;
      authorizationUrl: string;
      tokenUrl: string;
    };
    /** Only the current access token is passed to this environment variable. */
    accessTokenEnv?: string;
  };
}
export interface PluginDefinition {
  schemaVersion?: 1;
  key: string;
  version: string;
  name: string;
  description: string;
  publisher: string;
  category: string;
  featured: boolean;
  components: Array<"skills" | "mcp">;
  connections: PluginConnectorDefinition[];
  skills: PluginSkillDefinition[];
  homepageUrl?: string | null;
  sourceUrl?: string | null;
  sourceRevision?: string | null;
  logoUrl?: string | null;
  /** Relative PNG, JPEG or WebP path in binaryFiles; rendered without a network request. */
  icon?: string | null;
  setupFields?: PluginField[];
  setup?: PluginSetup | null;
  /** UTF-8 package files, including skill assets. No installed values belong here. */
  files?: Record<string, string>;
  binaryFiles?: Record<string, string>;
}
export interface PackagePreview {
  definition: PluginDefinition;
  warnings: string[];
  format: "openteam" | "agent-plugin" | "cursor-plugin";
}
export type SecretEdit =
  | { action: "keep" }
  | { action: "clear" }
  | { action: "replace"; value: string };
export type PluginInstallationMode = "optional" | "default" | "required" | "disabled";
