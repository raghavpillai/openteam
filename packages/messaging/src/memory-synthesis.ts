import type { ComputerInferenceRequest } from "@openteam/contracts/service-protocol";
import {
  normalizeMemoryContent,
  type MemorySynthesisChange,
  type MemorySynthesisSnapshot,
} from "./memory-files";
import {
  MEMORY_SYNTHESIS_SYSTEM_PROMPT,
  MEMORY_VERIFICATION_SYSTEM_PROMPT,
} from "./memory-prompts";

interface SynthesisEvidence {
  id: string;
  occurredAt: number;
  user: string;
  assistant: string;
}

type Inference = (
  request: Omit<ComputerInferenceRequest, "model" | "reasoning"> & { signal?: AbortSignal }
) => Promise<string>;

const waitForRetry = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Memory synthesis stopped"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("Memory synthesis stopped"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

const object = (value: unknown): Record<string, unknown> => {
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error("Expected a memory JSON object");
  return value as Record<string, unknown>;
};

const parseObject = (text: string): Record<string, unknown> => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Memory inference did not return a JSON object");
  return object(JSON.parse(text.slice(start, end + 1)));
};

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("Unexpected memory JSON fields");
  }
};

const identifier = (value: unknown): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new Error("Memory identifier must contain 1-64 characters");
  }
  return value;
};

export const parseMemorySynthesisChanges = (
  raw: string,
  evidenceIds: ReadonlySet<string>,
  temporal: boolean
): MemorySynthesisChange[] => {
  const result = parseObject(raw);
  exactKeys(result, ["changes"]);
  if (!Array.isArray(result.changes) || result.changes.length > 64) {
    throw new Error("Memory synthesis changes must be an array of at most 64 items");
  }
  return result.changes.map((rawChange): MemorySynthesisChange => {
    const change = object(rawChange);
    const action = change.action;
    if (action !== "create" && action !== "update" && action !== "remove")
      throw new Error("Invalid memory action");
    exactKeys(
      change,
      action === "create"
        ? ["action", "content", "kind", "sourceEvidenceIds"]
        : action === "update"
          ? ["action", "id", "content", "kind", "sourceEvidenceIds"]
          : ["action", "id", "sourceEvidenceIds"]
    );
    if (
      !Array.isArray(change.sourceEvidenceIds) ||
      change.sourceEvidenceIds.length < 1 ||
      change.sourceEvidenceIds.length > 32
    ) {
      throw new Error("Memory synthesis change requires 1-32 evidence ids");
    }
    const sourceEvidenceIds = change.sourceEvidenceIds.map((value) => {
      const id = identifier(value);
      if (!evidenceIds.has(id) && !(temporal && id === "clock"))
        throw new Error("Memory synthesis cited unknown evidence");
      return id;
    });
    if (action === "remove") return { action, id: identifier(change.id), sourceEvidenceIds };
    if (action === "create" && !sourceEvidenceIds.some((id) => id !== "clock")) {
      throw new Error("Memory creation requires conversation evidence");
    }
    if (
      typeof change.content !== "string" ||
      change.content.length < 1 ||
      change.content.length > 500 ||
      (change.kind !== "profile" && change.kind !== "log")
    ) {
      throw new Error("Invalid memory content or kind");
    }
    const content = normalizeMemoryContent(change.content);
    if (!content) throw new Error("Empty normalized memory content");
    return action === "create"
      ? { action, content, kind: change.kind, sourceEvidenceIds }
      : { action, id: identifier(change.id), content, kind: change.kind, sourceEvidenceIds };
  });
};

/** A retry covers the entire proposal/verifier pair, with a fresh 90s deadline. */
export const synthesizeMemories = async (input: {
  infer: Inference;
  snapshot: MemorySynthesisSnapshot;
  evidence: readonly SynthesisEvidence[];
  temporal: boolean;
  now?: number;
  deadlineMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<MemorySynthesisChange[]> => {
  const today = new Date(input.now ?? Date.now()).toISOString().slice(0, 10);
  const currentMemories = input.snapshot.memories.map((memory) => ({
    ...memory,
    origin: memory.origin === "synthesized" ? "synthesis" : memory.origin,
  }));
  const evidenceIds = new Set(input.evidence.map(({ id }) => id));
  const sleep = input.sleep ?? ((ms: number) => waitForRetry(ms, input.signal));
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (input.signal?.aborted) throw new Error("Memory synthesis stopped");
    const deadlineAt = Date.now() + (input.deadlineMs ?? 90_000);
    const infer = async (request: Omit<Parameters<Inference>[0], "timeoutMs">): Promise<string> => {
      const timeoutMs = deadlineAt - Date.now();
      if (timeoutMs <= 0) throw new Error("Memory synthesis deadline exceeded");
      if (input.signal?.aborted) throw new Error("Memory synthesis stopped");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        return await Promise.race([
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Memory synthesis deadline exceeded")),
              timeoutMs
            );
            abort = () => reject(new Error("Memory synthesis stopped"));
            input.signal?.addEventListener("abort", abort, { once: true });
          }),
          input.infer({ ...request, timeoutMs, signal: input.signal }),
        ]);
      } finally {
        clearTimeout(timer);
        if (abort) input.signal?.removeEventListener("abort", abort);
      }
    };
    try {
      const proposal = await infer({
        kind: "synthesis",
        instructions: MEMORY_SYNTHESIS_SYSTEM_PROMPT,
        prompt: JSON.stringify({ today, currentMemories, newEvidence: input.evidence }),
      });
      const changes = parseMemorySynthesisChanges(proposal, evidenceIds, input.temporal);
      if (!changes.length) return changes;
      const verdict = parseObject(
        await infer({
          kind: "verification",
          instructions: MEMORY_VERIFICATION_SYSTEM_PROMPT,
          prompt: JSON.stringify({
            today,
            currentMemories,
            evidence: input.evidence,
            proposedChanges: changes,
          }),
        })
      );
      exactKeys(verdict, ["approved"]);
      if (verdict.approved !== true)
        throw new Error("Memory synthesis verification rejected the proposal");
      return changes;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      lastError = error;
      if (attempt < 2) await sleep(Math.min(2_000 * 2 ** attempt, 30_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Memory synthesis failed");
};
