import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  botConversationSizeLimits,
  botSummaryMessage,
  canonicalJson,
  closeBotPreservedTail,
  sha256,
} from "./messages";
import type {
  BotArchiveBlob,
  BotArchiveCommitInput,
  BotArchiveIntent,
  BotArchiveIntentInput,
  BotArchiveManifest,
  BotArchiveRecord,
  BotMessage,
} from "./types";

export const EMPTY_MANIFEST: BotArchiveManifest = {
  version: 1,
  epoch: 0,
  selfSummaryCount: 0,
  latestArchiveId: null,
  archives: [],
};

export const CONTEXT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SHA256 = /^[0-9a-f]{64}$/;

export const COMPACTION_REASONS = new Set<string>([
  "approaching_token_limit",
  "approaching_image_limit",
  "fallback_on_limit_error",
  "input_token_limit_error",
  "self_summary_completed",
  // Read-only compatibility for archives produced before source validation
  // established that the 1,000-turn gate uses approaching_token_limit.
  "turn_limit",
]);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export const isNullableNonNegativeInteger = (value: unknown): value is number | null =>
  value === null || isNonNegativeInteger(value);

export const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

export const hasValidArchiveMetrics = (value: {
  tokensBefore: unknown;
  tokensAfter: unknown;
  imageCount: unknown;
  turnCount: unknown;
  startedAt: unknown;
  completedAt: unknown;
}): boolean =>
  isNullableNonNegativeInteger(value.tokensBefore) &&
  isNullableNonNegativeInteger(value.tokensAfter) &&
  isNonNegativeInteger(value.imageCount) &&
  isNonNegativeInteger(value.turnCount) &&
  isTimestamp(value.startedAt) &&
  isTimestamp(value.completedAt) &&
  Date.parse(value.completedAt) >= Date.parse(value.startedAt);

export const assertContextId = (value: string): string => {
  if (!CONTEXT_ID.test(value)) throw new Error("Invalid context session id");
  return value;
};

export const atomicWrite = async (path: string, data: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

export class BotCompactionArchiveStore {
  private readonly root: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  private directory(contextSessionId: string): string {
    return join(this.root, assertContextId(contextSessionId));
  }

  private intentPath(contextSessionId: string): string {
    return join(this.directory(contextSessionId), "compaction.intent.json");
  }

  private async locked<T>(contextSessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(contextSessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const chained = previous.then(() => current);
    this.locks.set(contextSessionId, chained);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(contextSessionId) === chained) this.locks.delete(contextSessionId);
    }
  }

  async manifest(contextSessionId: string): Promise<BotArchiveManifest> {
    const path = join(this.directory(contextSessionId), "manifest.json");
    if (!existsSync(path)) return structuredClone(EMPTY_MANIFEST);
    const parsed = JSON.parse(await readFile(path, "utf8")) as BotArchiveManifest;
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !Number.isInteger(parsed.epoch) ||
      !Array.isArray(parsed.archives) ||
      parsed.epoch !== parsed.archives.length ||
      !Number.isInteger(parsed.selfSummaryCount) ||
      parsed.selfSummaryCount < 0 ||
      parsed.selfSummaryCount > parsed.epoch ||
      parsed.archives.some(
        (archive, index) =>
          archive.sequence !== index + 1 ||
          !CONTEXT_ID.test(archive.id) ||
          !COMPACTION_REASONS.has(archive.reason) ||
          !SHA256.test(archive.prefixDigest) ||
          !SHA256.test(archive.summaryDigest) ||
          !SHA256.test(archive.summaryBlob) ||
          !hasValidArchiveMetrics(archive)
      ) ||
      new Set(parsed.archives.map((archive) => archive.id)).size !== parsed.archives.length ||
      parsed.latestArchiveId !== (parsed.archives.at(-1)?.id ?? null)
    ) {
      throw new Error(`Invalid compaction manifest for ${contextSessionId}`);
    }
    return parsed;
  }

  async latest(contextSessionId: string): Promise<BotArchiveBlob | null> {
    const manifest = await this.manifest(contextSessionId);
    if (!manifest.latestArchiveId) return null;
    const record = manifest.archives.find((item) => item.id === manifest.latestArchiveId);
    if (!record || !SHA256.test(record.summaryBlob)) {
      throw new Error(`Compaction manifest has an invalid latest archive for ${contextSessionId}`);
    }
    const path = join(this.directory(contextSessionId), "blobs", `${record.summaryBlob}.json`);
    const source = await readFile(path, "utf8");
    if (sha256(source) !== record.summaryBlob) {
      throw new Error(`Compaction archive digest mismatch for ${contextSessionId}`);
    }
    const blob = JSON.parse(source) as BotArchiveBlob;
    if (
      !isRecord(blob) ||
      blob.version !== 1 ||
      blob.id !== record.id ||
      blob.sequence !== record.sequence ||
      blob.reason !== record.reason ||
      blob.prefixDigest !== record.prefixDigest ||
      blob.summaryDigest !== record.summaryDigest ||
      typeof blob.summary !== "string" ||
      sha256(blob.summary) !== record.summaryDigest ||
      !Number.isInteger(blob.piBaseMessageCount) ||
      blob.piBaseMessageCount < 0 ||
      !blob.lastUserMessage ||
      !isRecord(blob.lastUserMessage) ||
      (blob.userInfoMessage !== null && !isRecord(blob.userInfoMessage)) ||
      !Array.isArray(blob.preservedTailMessages) ||
      (blob.durableBlocks !== undefined &&
        (!Array.isArray(blob.durableBlocks) ||
          blob.durableBlocks.some((block) => typeof block !== "string"))) ||
      (blob.summarizedMessages !== undefined && !Array.isArray(blob.summarizedMessages)) ||
      !isNonNegativeInteger(blob.selfSummaryCount) ||
      blob.selfSummaryCount < 1 ||
      blob.selfSummaryCount > blob.sequence ||
      (blob.usage !== null && !isRecord(blob.usage)) ||
      !hasValidArchiveMetrics(blob) ||
      blob.tokensBefore !== record.tokensBefore ||
      blob.tokensAfter !== record.tokensAfter ||
      blob.imageCount !== record.imageCount ||
      blob.turnCount !== record.turnCount ||
      blob.startedAt !== record.startedAt ||
      blob.completedAt !== record.completedAt
    ) {
      throw new Error(`Compaction archive metadata mismatch for ${contextSessionId}`);
    }
    return blob;
  }

  async stagedId(contextSessionId: string): Promise<string | null> {
    return (await this.readIntent(contextSessionId))?.archive.id ?? null;
  }

  private async readIntent(contextSessionId: string): Promise<BotArchiveIntent | null> {
    const path = this.intentPath(contextSessionId);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(await readFile(path, "utf8")) as BotArchiveIntent;
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      parsed.contextSessionId !== contextSessionId ||
      !isRecord(parsed.archive) ||
      !CONTEXT_ID.test(parsed.archive.id) ||
      !COMPACTION_REASONS.has(parsed.archive.reason) ||
      !SHA256.test(parsed.archive.prefixDigest) ||
      typeof parsed.archive.summary !== "string" ||
      !parsed.archive.lastUserMessage ||
      !isRecord(parsed.archive.lastUserMessage) ||
      (parsed.archive.userInfoMessage !== null && !isRecord(parsed.archive.userInfoMessage)) ||
      !Array.isArray(parsed.archive.preservedTailMessages) ||
      (parsed.archive.durableBlocks !== undefined &&
        (!Array.isArray(parsed.archive.durableBlocks) ||
          parsed.archive.durableBlocks.some((block) => typeof block !== "string"))) ||
      (parsed.archive.summarizedMessages !== undefined &&
        !Array.isArray(parsed.archive.summarizedMessages)) ||
      (parsed.archive.usage !== null && !isRecord(parsed.archive.usage)) ||
      !hasValidArchiveMetrics(parsed.archive)
    ) {
      throw new Error(`Invalid compaction intent for ${contextSessionId}`);
    }
    return parsed;
  }

  async stage(contextSessionId: string, archive: BotArchiveIntentInput): Promise<void> {
    await this.locked(contextSessionId, async () => {
      const manifest = await this.manifest(contextSessionId);
      if (manifest.archives.some((record) => record.id === archive.id)) {
        throw new Error(`Compaction ${archive.id} is already adopted`);
      }
      await atomicWrite(
        this.intentPath(contextSessionId),
        canonicalJson({ version: 1, contextSessionId, archive } satisfies BotArchiveIntent)
      );
    });
  }

  async discardStaged(contextSessionId: string): Promise<void> {
    await this.locked(contextSessionId, async () => {
      await unlink(this.intentPath(contextSessionId)).catch(() => undefined);
    });
  }

  async contextMessages(
    contextSessionId: string,
    piMessages: readonly BotMessage[]
  ): Promise<BotMessage[]> {
    const latest = await this.latest(contextSessionId);
    if (!latest) return structuredClone([...piMessages]);
    if (piMessages.length < latest.piBaseMessageCount) {
      throw new Error(`Pi context is older than its compaction archive for ${contextSessionId}`);
    }
    const appendedMessages = structuredClone(piMessages.slice(latest.piBaseMessageCount));
    const archivedPrefix = latest.summarizedMessages ?? [];
    const preservedTail = closeBotPreservedTail(archivedPrefix.length, [
      ...archivedPrefix,
      ...latest.preservedTailMessages,
    ]);
    return [
      ...(latest.userInfoMessage ? [structuredClone(latest.userInfoMessage)] : []),
      structuredClone(latest.lastUserMessage),
      botSummaryMessage(
        latest.summary,
        latest.selfSummaryCount,
        new Date(latest.completedAt).getTime(),
        latest.durableBlocks ?? []
      ),
      ...preservedTail,
      ...appendedMessages,
    ];
  }

  private async commitLocked(
    contextSessionId: string,
    input: BotArchiveCommitInput
  ): Promise<BotArchiveBlob> {
    const manifest = await this.manifest(contextSessionId);
    const sequence = manifest.epoch + 1;
    const summaryDigest = sha256(input.summary);
    const blob: BotArchiveBlob = {
      ...input,
      version: 1,
      sequence,
      selfSummaryCount: manifest.selfSummaryCount + 1,
      summaryDigest,
    };
    const source = canonicalJson(blob);
    const summaryBlob = sha256(source);
    const directory = this.directory(contextSessionId);
    const blobPath = join(directory, "blobs", `${summaryBlob}.json`);
    if (!existsSync(blobPath)) await atomicWrite(blobPath, source);
    const record: BotArchiveRecord = {
      id: blob.id,
      sequence,
      reason: blob.reason,
      prefixDigest: blob.prefixDigest,
      summaryDigest,
      summaryBlob,
      tokensBefore: blob.tokensBefore,
      tokensAfter: blob.tokensAfter,
      imageCount: blob.imageCount,
      turnCount: blob.turnCount,
      startedAt: blob.startedAt,
      completedAt: blob.completedAt,
    };
    const next: BotArchiveManifest = {
      version: 1,
      epoch: sequence,
      selfSummaryCount: blob.selfSummaryCount,
      latestArchiveId: blob.id,
      archives: [...manifest.archives, record],
    };
    await atomicWrite(join(directory, "manifest.json"), canonicalJson(next));
    return blob;
  }

  async commit(contextSessionId: string, input: BotArchiveCommitInput): Promise<BotArchiveBlob> {
    return this.locked(contextSessionId, () => this.commitLocked(contextSessionId, input));
  }

  async commitStaged(
    contextSessionId: string,
    compactionId: string,
    piBaseMessageCount: number
  ): Promise<BotArchiveBlob> {
    return this.locked(contextSessionId, async () => {
      const intent = await this.readIntent(contextSessionId);
      if (!intent || intent.archive.id !== compactionId) {
        throw new Error(`Missing compaction intent ${compactionId} for ${contextSessionId}`);
      }
      const manifest = await this.manifest(contextSessionId);
      if (manifest.archives.some((record) => record.id === compactionId)) {
        const adopted = await this.latest(contextSessionId);
        if (!adopted || adopted.id !== compactionId) {
          throw new Error(`Compaction ${compactionId} is not the latest adopted archive`);
        }
        await unlink(this.intentPath(contextSessionId)).catch(() => undefined);
        return adopted;
      }
      const blob = await this.commitLocked(contextSessionId, {
        ...intent.archive,
        piBaseMessageCount,
      });
      // The manifest is authoritative. A crash or unlink failure here only
      // leaves a replayable intent, which commitStaged treats idempotently.
      await unlink(this.intentPath(contextSessionId)).catch(() => undefined);
      return blob;
    });
  }

  async beginUserQuery(contextSessionId: string): Promise<void> {
    await this.locked(contextSessionId, async () => {
      const manifest = await this.manifest(contextSessionId);
      if (manifest.selfSummaryCount === 0) return;
      await atomicWrite(
        join(this.directory(contextSessionId), "manifest.json"),
        canonicalJson({ ...manifest, selfSummaryCount: 0 })
      );
    });
  }

  async bytes(contextSessionId: string, sessionPath?: string | null): Promise<number> {
    let total = 0;
    const directory = this.directory(contextSessionId);
    if (existsSync(directory)) {
      const manifestPath = join(directory, "manifest.json");
      if (existsSync(manifestPath)) total += (await stat(manifestPath)).size;
      const intentPath = this.intentPath(contextSessionId);
      if (existsSync(intentPath)) total += (await stat(intentPath)).size;
      const blobs = join(directory, "blobs");
      if (existsSync(blobs)) {
        for (const name of await readdir(blobs)) {
          if (name.endsWith(".json")) total += (await stat(join(blobs, name))).size;
        }
      }
    }
    if (sessionPath && existsSync(sessionPath)) total += (await stat(sessionPath)).size;
    return total;
  }

  async collectOrphans(contextSessionId: string): Promise<number> {
    return this.locked(contextSessionId, async () => {
      const manifest = await this.manifest(contextSessionId);
      const referenced = new Set(manifest.archives.map((record) => `${record.summaryBlob}.json`));
      const directory = join(this.directory(contextSessionId), "blobs");
      if (!existsSync(directory)) return 0;
      let reclaimed = 0;
      for (const name of await readdir(directory)) {
        if (!name.endsWith(".json") || referenced.has(name)) continue;
        const path = join(directory, name);
        reclaimed += (await stat(path)).size;
        await unlink(path);
      }
      return reclaimed;
    });
  }

  async enforceSizeLimit(
    contextSessionId: string,
    sessionPath?: string | null,
    limits: { soft?: number; hard?: number } = {}
  ): Promise<{ bytes: number; reclaimed: number }> {
    const configured = botConversationSizeLimits();
    const soft = limits.soft ?? configured.soft;
    const hard = limits.hard ?? configured.hard;
    let bytes = await this.bytes(contextSessionId, sessionPath);
    let reclaimed = 0;
    if (bytes > soft) {
      reclaimed = await this.collectOrphans(contextSessionId);
      bytes = await this.bytes(contextSessionId, sessionPath);
    }
    if (bytes > hard) {
      throw new Error(
        `SAND-E0414 conversationTooLarge: conversation state is ${bytes} bytes after GC; start a new conversation`
      );
    }
    return { bytes, reclaimed };
  }

  async remove(contextSessionId: string): Promise<void> {
    await this.locked(contextSessionId, () =>
      rm(this.directory(contextSessionId), { recursive: true, force: true })
    );
  }
}
