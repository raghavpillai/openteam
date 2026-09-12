import { ApiError, type SearchCategory } from "@openteam/contracts";
import type { RoutineMutationInput } from "@openteam/messaging";

export const searchCategories = new Set<SearchCategory>([
  "all",
  "messages",
  "bots",
  "channels",
  "files",
  "links",
  "routines",
]);

export const eventCursor = (value: string | null): bigint => {
  if (value === null || value === "") return 0n;
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "invalid_cursor", "Event cursor is invalid");
  }
  try {
    return BigInt(value);
  } catch {
    throw new ApiError(400, "invalid_cursor", "Event cursor is invalid");
  }
};

export const boundedQueryInteger = (
  value: string | null,
  fallback: number,
  maximum: number,
  name: string
): number => {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "invalid_query_parameter", `${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new ApiError(400, "invalid_query_parameter", `${name} is outside the supported range`);
  }
  return parsed;
};

export const historyCursor = (value: string | null): bigint | null => {
  if (value === null || value === "") return null;
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "invalid_history_cursor", "History cursor is invalid");
  }
  const parsed = BigInt(value);
  if (parsed < 1n) {
    throw new ApiError(400, "invalid_history_cursor", "History cursor must be positive");
  }
  return parsed;
};

export const routineBody = async (
  request: Request
): Promise<RoutineMutationInput & { clientId: string }> => {
  const raw = await request.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "invalid_routine", "Routine input must be an object");
  }
  const input = raw as Record<string, unknown>;
  const optionalString = (field: string): string | undefined => {
    const value = input[field];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      throw new ApiError(400, "invalid_routine", `${field} must be a string`);
    }
    return value;
  };
  const optionalBoolean = (field: string): boolean | undefined => {
    const value = input[field];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
      throw new ApiError(400, "invalid_routine", `${field} must be a boolean`);
    }
    return value;
  };
  const expectedRevision = input.expectedRevision;
  if (
    expectedRevision !== undefined &&
    (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 1)
  ) {
    throw new ApiError(400, "invalid_routine", "expectedRevision must be a positive integer");
  }
  const presentation = input.presentation;
  if (
    presentation !== undefined &&
    (!presentation ||
      typeof presentation !== "object" ||
      Array.isArray(presentation) ||
      JSON.stringify(presentation).length > 100_000)
  ) {
    throw new ApiError(400, "invalid_routine", "presentation must be a bounded object");
  }
  return {
    action: "update",
    name: optionalString("name"),
    prompt: optionalString("prompt"),
    schedule: optionalString("schedule"),
    trigger: input.trigger,
    presentation,
    enabled: optionalBoolean("enabled"),
    expectedRevision: expectedRevision === undefined ? undefined : Number(expectedRevision),
    clientId:
      typeof input.clientId === "string" && input.clientId.trim()
        ? input.clientId
        : crypto.randomUUID(),
  };
};
