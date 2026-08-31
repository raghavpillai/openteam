import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type LocalToolPermission = "always" | "ask" | "never";
export type AutoReviewRuleKind = "allow" | "block";

export interface PermissionSettings {
  version: 1;
  machineLabel: string | null;
  localToolPermission: LocalToolPermission;
  autoReview: {
    isEnabled: boolean;
    allowInstructions: string[];
    blockInstructions: string[];
  };
}

export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
  version: 1,
  machineLabel: null,
  localToolPermission: "ask",
  autoReview: {
    isEnabled: true,
    allowInstructions: [],
    blockInstructions: [],
  },
};

const MAX_RULES_PER_KIND = 20;
const MAX_RULE_LENGTH = 1_000;

const normalizeRules = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const rule = candidate.trim().slice(0, MAX_RULE_LENGTH);
    const key = rule.toLocaleLowerCase();
    if (!rule || seen.has(key)) continue;
    seen.add(key);
    rules.push(rule);
    if (rules.length === MAX_RULES_PER_KIND) break;
  }
  return rules;
};

export const normalizePermissionSettings = (value: unknown): PermissionSettings => {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const autoReview =
    record.autoReview && typeof record.autoReview === "object" && !Array.isArray(record.autoReview)
      ? (record.autoReview as Record<string, unknown>)
      : {};
  const localToolPermission = ["always", "ask", "never"].includes(
    String(record.localToolPermission)
  )
    ? (record.localToolPermission as LocalToolPermission)
    : DEFAULT_PERMISSION_SETTINGS.localToolPermission;
  return {
    version: 1,
    machineLabel:
      typeof record.machineLabel === "string" && record.machineLabel.trim()
        ? record.machineLabel.trim().slice(0, 80)
        : null,
    localToolPermission,
    autoReview: {
      isEnabled:
        typeof autoReview.isEnabled === "boolean"
          ? autoReview.isEnabled
          : DEFAULT_PERMISSION_SETTINGS.autoReview.isEnabled,
      allowInstructions: normalizeRules(autoReview.allowInstructions),
      blockInstructions: normalizeRules(autoReview.blockInstructions),
    },
  };
};

export interface PermissionSettingsStore {
  read(): Promise<PermissionSettings>;
  update(input: {
    machineLabel?: string;
    localToolPermission?: LocalToolPermission;
    autoReviewEnabled?: boolean;
  }): Promise<PermissionSettings>;
  addRule(kind: AutoReviewRuleKind, instruction: string): Promise<PermissionSettings>;
  removeRule(kind: AutoReviewRuleKind, instruction: string): Promise<PermissionSettings>;
}

export const createPermissionSettingsStore = (path: string): PermissionSettingsStore => {
  let writeSequence = Promise.resolve();

  const read = async (): Promise<PermissionSettings> => {
    try {
      return normalizePermissionSettings(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
        return structuredClone(DEFAULT_PERMISSION_SETTINGS);
      }
      throw error;
    }
  };

  const write = async (settings: PermissionSettings): Promise<PermissionSettings> => {
    const normalized = normalizePermissionSettings(settings);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
    return normalized;
  };

  const mutate = (operation: (settings: PermissionSettings) => PermissionSettings) => {
    const result = writeSequence.then(async () => write(operation(await read())));
    writeSequence = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  return {
    read,
    update: (input) =>
      mutate((settings) => ({
        ...settings,
        machineLabel: input.machineLabel?.trim().slice(0, 80) || settings.machineLabel,
        localToolPermission: input.localToolPermission ?? settings.localToolPermission,
        autoReview: {
          ...settings.autoReview,
          isEnabled: input.autoReviewEnabled ?? settings.autoReview.isEnabled,
        },
      })),
    addRule: (kind, instruction) =>
      mutate((settings) => {
        const key = kind === "allow" ? "allowInstructions" : "blockInstructions";
        return {
          ...settings,
          autoReview: {
            ...settings.autoReview,
            [key]: normalizeRules([...settings.autoReview[key], instruction]),
          },
        };
      }),
    removeRule: (kind, instruction) =>
      mutate((settings) => {
        const key = kind === "allow" ? "allowInstructions" : "blockInstructions";
        return {
          ...settings,
          autoReview: {
            ...settings.autoReview,
            [key]: settings.autoReview[key].filter((rule) => rule !== instruction),
          },
        };
      }),
  };
};
