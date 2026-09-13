import type { ConfigValue, PluginDefinition, PluginField, SecretEdit } from "./types";

export const isSecretKey = (key: string): boolean =>
  /token|secret|password|authorization|api.?key|cookie|credential/i.test(key);

export function validateValues(
  fields: readonly PluginField[],
  values: Record<string, unknown>,
  complete = true
): Record<string, ConfigValue> {
  const result: Record<string, ConfigValue> = {};
  for (const field of fields) {
    const value = values[field.key] ?? (complete ? field.default : undefined);
    if (value === undefined || value === "") {
      if (complete && field.required) throw new Error(`${field.label} is required`);
      if (!complete && value === "") result[field.key] = "";
      continue;
    }
    const type = field.type ?? "string";
    if (
      type === "integer"
        ? typeof value !== "number" || !Number.isInteger(value)
        : typeof value !== type
    ) {
      throw new Error(`${field.label} must be ${type}`);
    }
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error(`${field.label} must be finite`);
    if (typeof value === "string" && value.length > 20_000)
      throw new Error(`${field.label} is too long`);
    if (field.enum && !field.enum.includes(value as ConfigValue))
      throw new Error(`${field.label} must be one of its listed options`);
    result[field.key] = value as ConfigValue;
  }
  for (const key of Object.keys(values)) {
    if (!fields.some((field) => field.key === key)) throw new Error(`Unknown setup field: ${key}`);
  }
  return result;
}

export const fieldsForConnector = (plugin: PluginDefinition, key: string): PluginField[] => {
  const fields = [
    ...(plugin.setupFields ?? []),
    ...((
      plugin.connections.find((c) => c.key === key)?.setup ??
      (plugin.setup?.connectionKey === key ? plugin.setup : null)
    )?.fields ?? []),
  ];
  return [...new Map(fields.map((field) => [field.key, field])).values()];
};

export function substituteConfiguration(
  value: unknown,
  values: Record<string, ConfigValue>
): unknown {
  if (typeof value === "string") {
    const exact = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (exact?.[1] && values[exact[1]] !== undefined) return values[exact[1]];
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) =>
      values[key] === undefined ? match : String(values[key])
    );
  }
  if (Array.isArray(value)) return value.map((entry) => substituteConfiguration(entry, values));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substituteConfiguration(entry, values)])
    );
  return value;
}

export function applySecretEdits(
  current: Record<string, string>,
  edits: Record<string, SecretEdit>
): Record<string, string> {
  const result = { ...current };
  for (const [key, edit] of Object.entries(edits)) {
    if (edit.action === "clear") delete result[key];
    else if (edit.action === "replace") {
      if (!edit.value || edit.value.length > 20_000) throw new Error(`Invalid value for ${key}`);
      result[key] = edit.value;
    }
  }
  return result;
}

/** Opaque account identity survives renames and cannot collide across connectors. */
export const connectionNamespace = (connectionId: string): string =>
  `plugin_${connectionId.replace(/[^a-zA-Z0-9]/g, "_")}`;

/** Only OS runtime essentials are inherited. All application/provider secrets are explicit. */
export function scopedProcessEnvironment(
  environment: Record<string, string | undefined>,
  configured: Record<string, string> = {}
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ]) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  return { ...result, ...configured };
}
