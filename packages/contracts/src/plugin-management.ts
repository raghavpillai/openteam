import { Schema } from "effect";
import type {
  ConfigValue,
  PackagePreview,
  PluginDefinition,
  PluginField,
  PluginInstallationMode,
  PluginSetup,
} from "@openteam/plugin-sdk";

const Scalar = Schema.Union(
  Schema.String.pipe(Schema.maxLength(20_000)),
  Schema.Number,
  Schema.Boolean
);
const Values = Schema.Record({ key: Schema.String, value: Scalar });
const TextMap = Schema.Record({ key: Schema.String, value: Schema.String });
export const PluginPackageInput = Schema.Struct({
  files: TextMap,
  sourceUrl: Schema.optional(Schema.String),
});
export const PluginUrlInput = Schema.Struct({
  url: Schema.String.pipe(Schema.maxLength(2000)),
  name: Schema.optional(Schema.String.pipe(Schema.maxLength(200))),
});
export const PluginDraftInput = Schema.Struct({ definition: Schema.Unknown });
export const PluginUpdateInput = Schema.Struct({ digest: Schema.String });
export const PluginModeInput = Schema.Struct({
  mode: Schema.Literal("optional", "default", "required", "disabled"),
});
export const PluginConfigurationInput = Schema.Struct({
  values: Schema.optional(Values),
  secrets: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Union(
        Schema.Struct({ action: Schema.Literal("keep", "clear") }),
        Schema.Struct({
          action: Schema.Literal("replace"),
          value: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(20_000)),
        })
      ),
    })
  ),
  endpoint: Schema.optional(Schema.String.pipe(Schema.maxLength(2000))),
  command: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
  args: Schema.optional(Schema.Array(Schema.String.pipe(Schema.maxLength(2000)))),
  cwd: Schema.optional(Schema.String.pipe(Schema.maxLength(2000))),
  env: Schema.optional(TextMap),
  headers: Schema.optional(TextMap),
  tokenEndpointAuthMethod: Schema.optional(
    Schema.Literal("none", "client_secret_post", "client_secret_basic")
  ),
});
export type PluginConfigurationInput = typeof PluginConfigurationInput.Type;
export const PluginSkillInput = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  description: Schema.String.pipe(Schema.maxLength(2000)),
  body: Schema.String.pipe(Schema.maxLength(1_000_000)),
  files: Schema.optional(TextMap),
  enabledBotIds: Schema.optional(Schema.Array(Schema.String)),
});
export type PluginSkillInput = typeof PluginSkillInput.Type;
export const PluginTestInput = Schema.Struct({
  toolName: Schema.String,
  arguments: Schema.Unknown,
  confirmSideEffect: Schema.optional(Schema.Boolean),
});
export type PluginTestInput = typeof PluginTestInput.Type;
export interface PluginConfigurationView {
  connectionId: string;
  namespace: string;
  endpoint: string | null;
  command: string | null;
  args: string[];
  cwd: string | null;
  values: Record<string, ConfigValue>;
  fields: PluginField[];
  configuredSecrets: string[];
  headerNames: string[];
  environmentNames: string[];
  setup: PluginSetup | null;
  callbackUrl: string;
  tokenEndpointAuthMethod: string;
}
export interface PluginSourceView {
  id: string;
  name: string;
  url: string;
  status: string;
  error: string | null;
  refreshedAt: string | null;
  pluginCount: number;
}
export interface PluginDraftView extends PackagePreview {
  id: string;
  name: string;
  sourceUrl: string | null;
  digest: string;
  updatedAt: string;
}
export interface PluginPrivateSkillView {
  id: string;
  name: string;
  description: string;
  body: string;
  files: Record<string, string>;
  enabledBotIds: string[];
}
export interface PluginManagementView {
  sources: PluginSourceView[];
  drafts: PluginDraftView[];
  skills: PluginPrivateSkillView[];
}
export interface PluginPackageView {
  definition: PluginDefinition;
  digest: string;
  mode: PluginInstallationMode;
  skillSyncStatus: string;
  skillSyncError: string | null;
  hasRollback: boolean;
  update: { definition: PluginDefinition; digest: string; changes: string[] } | null;
}
export interface PluginComposerView {
  items: Array<{
    id: string;
    label: string;
    handle: string;
    trigger: "@" | "/";
    kind: "connection" | "skill";
    status: string;
  }>;
}
