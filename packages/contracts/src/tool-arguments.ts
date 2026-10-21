import { ParseResult } from "effect";
import { ZodError } from "zod";

/** The reference's argument report: one `path: message` line per issue, "argument" for the root. */
export const formatArgumentIssues = (
  issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }>
): string =>
  `Invalid arguments:\n${issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join(".") : "argument"}: ${issue.message}`)
    .join("\n")}`;

/** The argument report for a zod or Effect decode failure; undefined for any other error. */
export function invalidArgumentsMessage(error: unknown): string | undefined {
  if (error instanceof ZodError) return formatArgumentIssues(error.issues);
  if (ParseResult.isParseError(error)) return formatArgumentIssues(ParseResult.ArrayFormatter.formatErrorSync(error));
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const BOOLEAN_SPELLINGS = new Map([["true", true], ["True", true], ["false", false], ["False", false]]);
const NULL_SPELLINGS = new Set(["null", "None"]);

function kindsOf(schema: unknown): Set<string> {
  if (!isRecord(schema)) return new Set();
  const kinds = new Set<string>();
  for (const option of [...((schema.anyOf as unknown[]) ?? []), ...((schema.oneOf as unknown[]) ?? [])])
    for (const kind of kindsOf(option)) kinds.add(kind);
  for (const type of Array.isArray(schema.type) ? schema.type : [schema.type]) if (typeof type === "string") kinds.add(type);
  for (const value of Array.isArray(schema.enum) ? schema.enum : "const" in schema ? [schema.const] : [])
    kinds.add(value === null ? "null" : typeof value);
  if (!kinds.size && isRecord(schema.properties)) kinds.add("object");
  return kinds;
}

const parseContainer = (value: string): unknown => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
};

/** String-encoded arguments become the advertised type: booleans, numbers, null, and JSON objects or arrays. */
export function coerceArgumentsToJsonSchema(schema: unknown, value: unknown): unknown {
  if (!isRecord(schema)) return value;
  if (typeof value === "string") {
    const kinds = kindsOf(schema);
    if (kinds.has("string") || !kinds.size) return value;
    if (kinds.has("null") && NULL_SPELLINGS.has(value)) return null;
    if (kinds.has("boolean") && BOOLEAN_SPELLINGS.has(value)) return BOOLEAN_SPELLINGS.get(value);
    const number = value.trim() ? Number(value.trim()) : Number.NaN;
    if (Number.isFinite(number) && (kinds.has("number") || (kinds.has("integer") && Number.isInteger(number)))) return number;
    if (!kinds.has("object") && !kinds.has("array")) return value;
    const parsed = parseContainer(value);
    return (Array.isArray(parsed) ? kinds.has("array") : isRecord(parsed) && kinds.has("object"))
      ? coerceArgumentsToJsonSchema(schema, parsed)
      : value;
  }
  const options = [...((schema.anyOf as unknown[]) ?? []), ...((schema.oneOf as unknown[]) ?? [])];
  if (Array.isArray(value)) {
    const owner = isRecord(schema.items) ? schema : options.find((option) => isRecord(option) && isRecord(option.items));
    const itemSchema = isRecord(owner) ? owner.items : undefined;
    if (!isRecord(itemSchema)) return value;
    const next = value.map((item) => coerceArgumentsToJsonSchema(itemSchema, item));
    return next.some((item, index) => item !== value[index]) ? next : value;
  }
  if (!isRecord(value)) return value;
  const properties = isRecord(schema.properties)
    ? schema.properties
    : (options.find((option) => isRecord(option) && isRecord(option.properties)) as Record<string, any> | undefined)?.properties;
  const extra = isRecord(schema.additionalProperties) ? schema.additionalProperties : undefined;
  if (!isRecord(properties) && !extra) return value;
  const entries = Object.entries(value);
  const next = entries.map(([key, entry]) => {
    const entrySchema = isRecord(properties) && Object.hasOwn(properties, key) ? properties[key] : extra;
    return [key, entrySchema === undefined ? entry : coerceArgumentsToJsonSchema(entrySchema, entry)] as const;
  });
  return next.some(([, coerced], index) => coerced !== entries[index]![1]) ? Object.fromEntries(next) : value;
}
