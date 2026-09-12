import type { Prisma } from "@openteam/db";
import { Effect } from "effect";
import { createHash } from "node:crypto";

export const toJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(
    JSON.stringify(value, (_key, nested) =>
      typeof nested === "bigint" ? nested.toString() : nested
    )
  ) as Prisma.InputJsonValue;

export const hashRequest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const slugify = (value: string): string => {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "bot";
};

export const appendEvent = (
  tx: Prisma.TransactionClient,
  topic: string,
  entityId: string | null,
  payload: unknown
) => tx.event.create({ data: { topic, entityId, payload: toJson(payload) } });

export const toError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

export type ComputerFetch = (path: string, init: RequestInit) => Promise<Response>;

export const metadataRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};

export const serviceEffect = <A>(
  operation: (signal: AbortSignal) => PromiseLike<A>
): Effect.Effect<A, Error> => Effect.tryPromise({ try: operation, catch: toError });

/** Resolve a service's bound arrow method lazily, after constructor wiring. */
export const forwardServiceMethod =
  <Args extends unknown[], Result>(method: () => (...args: Args) => Result) =>
  (...args: Args): Result =>
    method()(...args);
