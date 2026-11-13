import { expect } from "bun:test";
import { Effect } from "effect";
import { MAX_THREAD_CONTEXT_MESSAGES, SnapshotService } from "../src/services/snapshot-service";
import { dbIt } from "./harness";

const snapshots = (db: ConstructorParameters<typeof SnapshotService>[0]) => new SnapshotService(db, "/workspace", "http://computer", () => true);

dbIt("history keeps its cursor contiguous while supplying an older thread-root chain, and message context pages around a target", async ({ db, bot }) => {
  const { channelId } = await bot("History");
  const rows: Array<{ id: string; sequence: bigint }> = [];
  for (let n = 1; n <= 10; n++) {
    const replyTo = n === 2 ? rows[0]!.id : n === 10 ? rows[1]!.id : undefined;
    rows.push(await db.channelMessage.create({ data: { channelId: channelId!, sender: "user", clientId: `send-${n}`, content: `message ${n}`, metadata: replyTo ? { branched: true, replyTo } : {} } }));
  }
  const seq = (...indexes: number[]) => indexes.map(index => String(rows[index - 1]!.sequence));
  const service = snapshots(db);
  const page = await Effect.runPromise(service.history(channelId!, null, 2));
  expect(page.messages.map(({ sequence }) => sequence)).toEqual(seq(9, 10));
  expect(page.beforeSequence).toBe(seq(9)[0]!);
  expect(page.threadContext.map(({ sequence }) => sequence)).toEqual(seq(1, 2));
  expect(page.threadContext.map(({ clientId }) => clientId)).toEqual(["send-1", "send-2"]);
  expect(page.threadContextTruncated).toBe(false);
  expect(page.messages.length + page.threadContext.length).toBeLessThanOrEqual(2 + MAX_THREAD_CONTEXT_MESSAGES);

  const context = await Effect.runPromise(service.messageContext(rows[9]!.id, 1, 1));
  expect(context).toMatchObject({ targetMessageId: rows[9]!.id, beforeSequence: seq(9)[0], afterSequence: seq(10)[0], hasMoreBefore: true, hasMoreAfter: false, threadContextTruncated: false });
  expect(context.messages.map(({ sequence }) => sequence)).toEqual(seq(9, 10));
  expect(context.threadContext.map(({ sequence }) => sequence)).toEqual(seq(1, 2));
  const root = await Effect.runPromise(service.messageContext(rows[0]!.id, 0, 2));
  expect(root).toMatchObject({ targetMessageId: rows[0]!.id, beforeSequence: seq(1)[0], afterSequence: seq(3)[0], hasMoreBefore: false, hasMoreAfter: true });
  expect(root.messages.map(({ sequence }) => sequence)).toEqual(seq(1, 2, 3));
  expect(root.threadContext).toEqual([]);
});

dbIt("client state carries run items only for queued or running runs, and a parked request without its private evidence", async ({ db, bot, run }) => {
  const owner = await bot("State");
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 16, 12, 0, seconds));
  const waiting = await run(owner, { status: "completed", createdAt: at(0), requestProgress: { state: "waiting", evidence: ["private evidence"] }, requestNextCheckAt: at(3600) });
  const finished = await run(owner, { status: "completed", createdAt: at(1) });
  const running = await run(owner, { status: "running", createdAt: at(2) });
  const active = await db.runItem.create({ data: { runId: running.id, kind: "tool" as never } });
  await db.runItem.create({ data: { runId: finished.id, kind: "tool" as never } });
  const state = await Effect.runPromise(snapshots(db).channelState(owner.channelId!));
  expect(state.runs.map(({ id }) => id)).toEqual([waiting.id, finished.id, running.id]);
  expect(state.runs[0]?.requestState).toBe("waiting");
  expect(JSON.stringify(state)).not.toContain("private evidence");
  expect(state.runItems.map(({ id }) => id)).toEqual([active.id]);
  expect(state.truncated.runItems).toBe(false);
});
