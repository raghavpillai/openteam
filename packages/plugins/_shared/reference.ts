import gmail from "./reference/gmail.json";
import calendar from "./reference/calendar.json";
import drive from "./reference/drive.json";
import { tool, type Tool } from "./google";

// Pinned public tools/list snapshots, retrieved 2026-09-12. See reference/README.md.
export const referenceTools = { gmail, calendar, drive };
export function referenceTool(
  provider: keyof typeof referenceTools,
  name: string,
  run: Tool["run"],
  options: {
    risk?: "read" | "write" | "destructive";
    properties?: Record<string, any>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    description?: string;
  } = {}
): Tool {
  const reference = referenceTools[provider].find((entry) => entry.name === name);
  if (!reference) throw new Error(`Missing reference tool: ${provider}/${name}`);
  const schema: any = structuredClone(reference.inputSchema);
  const entry = tool(name, options.description ?? reference.description, {}, [], run, options.risk);
  entry.inputSchema = {
    ...schema,
    properties: { ...schema.properties, ...options.properties },
    required: options.required ?? schema.required ?? [],
    additionalProperties: false,
    ...(options.anyOf ? { anyOf: options.anyOf } : {}),
  };
  return entry;
}

export async function mapConcurrent<T, R>(items: T[], run: (item: T) => Promise<R>, concurrency = 4): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  }));
  return results;
}

export const compact = <T extends Record<string, any>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

export function base64Bytes(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new Error("Content must be valid padded base64");
  return Buffer.from(value, "base64");
}
