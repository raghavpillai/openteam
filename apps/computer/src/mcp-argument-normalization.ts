/**
 * The reference's CallDynamicTool repair of connector arguments against the
 * advertised input schema (mcp-argument-schema-normalization): loose key
 * spelling, enum case, stringified objects, a mistaken envelope, singular and
 * plural keys, a lone undeclared key moved to the lone missing required key,
 * and a scalar wrapped into a one-item array. Everything else goes to the
 * server unchanged; only missing required keys are refused here.
 */
type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const looseKey = (key: string) => key.replace(/[_-]/g, "").toLowerCase();
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const schemaProperties = (schema: Json): Json => (isObject(schema.properties) ? schema.properties : {});

function normalizeEnum(schema: Json, value: unknown): unknown {
  const options = schema.enum;
  if (typeof value !== "string" || !Array.isArray(options) || options.includes(value)) return value;
  const [match, ...others] = options.filter((option) => typeof option === "string" && option.toLowerCase() === value.toLowerCase());
  return match === undefined || others.length > 0 ? value : match;
}

function normalizeObject(value: Json, schema: Json): Json {
  const properties = schema.properties;
  if (!isObject(properties)) return value;
  const looseDeclared = new Map<string, string | null>();
  for (const declared of Object.keys(properties)) {
    const loose = looseKey(declared);
    looseDeclared.set(loose, looseDeclared.has(loose) ? null : declared);
  }
  const normalized: Json = {};
  for (const [key, entry] of Object.entries(value)) if (Object.hasOwn(properties, key)) normalized[key] = entry;
  for (const [key, entry] of Object.entries(value)) {
    if (Object.hasOwn(properties, key)) continue;
    const target = looseDeclared.get(looseKey(key));
    if (typeof target === "string" && !Object.hasOwn(normalized, target)) normalized[target] = entry;
    else normalized[key] = entry;
  }
  for (const [key, property] of Object.entries(properties)) {
    const entry = normalized[key];
    if (entry === undefined || !isObject(property)) continue;
    if (isObject(entry)) normalized[key] = normalizeObject(entry, property);
    else if (Array.isArray(entry) && isObject(property.items)) {
      const items = property.items;
      normalized[key] = entry.map((item) => (isObject(item) ? normalizeObject(item, items) : normalizeEnum(items, item)));
    } else normalized[key] = normalizeEnum(property, entry);
  }
  return normalized;
}

const TYPE_CHECKS = new Map<string, (value: unknown) => boolean>([
  ["string", (value) => typeof value === "string"],
  ["integer", (value) => typeof value === "number" && Number.isInteger(value)],
  ["number", (value) => typeof value === "number"],
  ["boolean", (value) => typeof value === "boolean"],
  ["array", (value) => Array.isArray(value)],
  ["object", (value) => isObject(value)],
]);
const schemaTypes = (property: Json): string[] =>
  typeof property.type === "string" ? [property.type] : arrayOf(property.type).filter((entry): entry is string => typeof entry === "string");
function fitsProperty(property: unknown, value: unknown): boolean {
  if (!isObject(property)) return false;
  if (Array.isArray(property.enum)) return property.enum.includes(value);
  return schemaTypes(property).some((type) => TYPE_CHECKS.get(type)?.(value) === true);
}
function valueForProperty(property: unknown, value: unknown): unknown {
  if (fitsProperty(property, value)) return value;
  const wrapsScalar = isObject(property) && schemaTypes(property).includes("array") && !Array.isArray(value) && fitsProperty(property.items, value);
  return wrapsScalar ? [value] : undefined;
}

function withScalarArrayWraps(value: Json, schema: Json): Json {
  const properties = schemaProperties(schema);
  const wrapped = Object.entries(value).filter(([key, entry]) =>
    Object.hasOwn(properties, key) && !Array.isArray(entry) && !fitsProperty(properties[key], entry) && valueForProperty(properties[key], entry) !== undefined);
  return wrapped.length ? { ...value, ...Object.fromEntries(wrapped.map(([key, entry]) => [key, [entry]])) } : value;
}

const RENAMEABLE_KEY = /^[A-Za-z_@][A-Za-z0-9_.-]{0,63}$/;
const isUnmatchedKey = (key: string, properties: Json) =>
  !Object.hasOwn(properties, key) && RENAMEABLE_KEY.test(key) &&
  !Object.keys(properties).some((declared) => looseKey(declared) === looseKey(key));
const isSingularPluralPair = (a: string, b: string) => [`${a}s`, `${a}es`].includes(b) || [`${b}s`, `${b}es`].includes(a);

type Rename = { from: string; to: string; value: unknown };
function withUnmatchedRenames(sent: Json, schema: Json): Json {
  const properties = schemaProperties(schema);
  const unsent = Object.keys(properties).filter((key) => !Object.hasOwn(sent, key));
  const renames: Rename[] = [];
  for (const [key, value] of Object.entries(sent)) {
    if (!isUnmatchedKey(key, properties)) continue;
    const claimed = renames.map((rename) => rename.to);
    const [target, ...others] = unsent.filter((declared) => !claimed.includes(declared) && isSingularPluralPair(looseKey(key), looseKey(declared)));
    if (target === undefined || others.length > 0) continue;
    const moved = valueForProperty(properties[target], value);
    if (moved !== undefined) renames.push({ from: key, to: target, value: moved });
  }
  const renamed = new Set(renames.flatMap((rename) => [rename.from, rename.to]));
  const undeclared = Object.keys(sent).filter((key) => !Object.hasOwn(properties, key) && !renamed.has(key));
  const missing = arrayOf(schema.required).filter((key): key is string => typeof key === "string" && !Object.hasOwn(sent, key) && !renamed.has(key));
  const from = undeclared.length === 1 ? undeclared.filter((key) => isUnmatchedKey(key, properties))[0] : undefined;
  const to = missing.length === 1 ? missing[0] : undefined;
  if (from !== undefined && to !== undefined && sent[from] !== undefined) {
    const moved = valueForProperty(properties[to], sent[from]);
    if (moved !== undefined) renames.push({ from, to, value: moved });
  }
  if (!renames.length) return sent;
  const moved = new Set(renames.map((rename) => rename.from));
  return { ...Object.fromEntries(Object.entries(sent).filter(([key]) => !moved.has(key))), ...Object.fromEntries(renames.map((rename) => [rename.to, rename.value])) };
}

function objectSchemaKeys(schema: unknown): Set<string> | undefined {
  if (!isObject(schema)) return undefined;
  let keys: Set<string> | undefined;
  for (const branch of [schema, ...arrayOf(schema.anyOf), ...arrayOf(schema.oneOf)]) {
    if (!isObject(branch) || !isObject(branch.properties)) continue;
    keys ??= new Set();
    for (const key of Object.keys(branch.properties)) keys.add(looseKey(key));
  }
  return keys;
}
function parseJsonObject(value: unknown): Json | undefined {
  if (typeof value !== "string" || !value.trimStart().startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
const missingRequiredKeys = (value: Json, schema: Json) =>
  arrayOf(schema.required).filter((key): key is string => typeof key === "string" && !Object.hasOwn(value, key));

function reshapeToSchema(value: Json, schema: Json): { value: Json; envelope?: "wrapped" | "unwrapped" } {
  const properties = schemaProperties(schema);
  const result = { ...value };
  for (const [key, property] of Object.entries(properties)) {
    const parsed = result[key] === undefined ? undefined : parseJsonObject(result[key]);
    if (parsed !== undefined && objectSchemaKeys(property) !== undefined) result[key] = parsed;
  }
  const missing = missingRequiredKeys(result, schema);
  const undeclared = Object.keys(result).filter((key) => !Object.hasOwn(properties, key));
  if (!missing.length || !undeclared.length) return { value: result };
  const envelopeKey = missing.length === 1 ? missing[0] : undefined;
  const envelopeKeys = envelopeKey === undefined ? undefined : objectSchemaKeys(properties[envelopeKey]);
  if (envelopeKey !== undefined && envelopeKeys !== undefined && undeclared.every((key) => envelopeKeys.has(looseKey(key)))) {
    const wrapped: Json = {};
    for (const key of undeclared) {
      if (result[key] !== undefined) wrapped[key] = result[key];
      delete result[key];
    }
    result[envelopeKey] = wrapped;
    return { value: result, envelope: "wrapped" };
  }
  const outerKey = undeclared.length === 1 ? undeclared[0]! : undefined;
  const inner = outerKey === undefined ? undefined : result[outerKey];
  const declared = new Set(Object.keys(properties).map(looseKey));
  if (outerKey !== undefined && isObject(inner) && Object.keys(inner).length > 0 &&
      Object.keys(inner).every((key) => declared.has(looseKey(key))) &&
      missing.some((key) => Object.keys(inner).some((sent) => looseKey(sent) === looseKey(key)))) {
    delete result[outerKey];
    for (const [key, entry] of Object.entries(inner)) if (!Object.hasOwn(result, key)) result[key] = entry;
    return { value: result, envelope: "unwrapped" };
  }
  return { value: result };
}

export function normalizeMcpArgumentsToInputSchema(
  args: Json,
  inputSchema: unknown
): { arguments: Json; missingRequired: string[]; undeclaredKeys: string[] } {
  if (!isObject(inputSchema)) return { arguments: args, missingRequired: [], undeclaredKeys: Object.keys(args) };
  let shaped = normalizeObject(args, inputSchema);
  const reshaped = reshapeToSchema(shaped, inputSchema);
  shaped = reshaped.envelope === "unwrapped" ? normalizeObject(reshaped.value, inputSchema) : reshaped.value;
  // Renames and scalar wraps graduated to always-on in the reference.
  const value = withScalarArrayWraps(withUnmatchedRenames(shaped, inputSchema), inputSchema);
  const properties = schemaProperties(inputSchema);
  return {
    arguments: value,
    missingRequired: missingRequiredKeys(value, inputSchema),
    undeclaredKeys: Object.keys(value).filter((key) => !Object.hasOwn(properties, key)),
  };
}

/** Normalized connector arguments, or the reference refusal when required keys are missing and nothing else could fill them. */
export function connectorArguments(toolName: string, args: Json, inputSchema: Readonly<Json>): Json {
  const normalized = normalizeMcpArgumentsToInputSchema(args, inputSchema);
  if (normalized.missingRequired.length && !normalized.undeclaredKeys.length)
    throw new Error(`Tool execution error. The call to ${toolName} was not sent: it is missing the required ${normalized.missingRequired.length === 1 ? "argument" : "arguments"} ${normalized.missingRequired.join(", ")}. Input schema:\n${JSON.stringify(inputSchema)}\nRebuild the arguments from this schema before retrying.`);
  return normalized.arguments;
}
