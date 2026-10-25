import {
  ApiError,
  formatPiModelRef,
  type CheckSubagentInput,
  type MessageSubagentInput,
  resolveBotAvatarMark,
  normalizePiReasoningLevel,
  type StopSubagentInput,
  SubagentType,
  type BusyBotsView,
  type TaskInput,
} from "@openteam/contracts";
import { COMPUTER_API_PATHS } from "@openteam/contracts/service-protocol";
import { Prisma, type PrismaClient } from "@openteam/db";
import { type AgentDataStore, type AgentMessaging, PRIORITY, type ToolContext } from "@openteam/messaging";
import { Effect, Schema } from "effect";
import { fromPrisma } from "pg-boss";
import type { RunService } from "../run-service";
import { appendEvent, type ComputerFetch, hashRequest, serviceEffect, stopSubagentShells, toJson } from "../service-utils";
import { taskInference, parseTaskConfiguration } from "@openteam/contracts/task-configuration";
import { normalizeSubagentTypeName, parentOnlyDispatchNotice, subagentTitle, withSiteDispatchNotes } from "@openteam/contracts/subagent-dispatch";

const ACTIVE_STATUSES = ["provisioning", "queued", "running"] as const;
// The sender's copy of a direct agent message, keyed by the call that sent it.
const A2A_OUTGOING_PREFIX = "a2a:out:";
const DELEGATED_WORK_WINDOW_MS = 24 * 60 * 60_000;

// The reference's activity log: a call adds "[pending] Name" when it starts and "[done]" or
// "[failed]" when it ends, repeats collapse, and only the newest 24 entries are kept.
const ACTIVITY_ENTRIES = 24;
const FINISHED_ITEM_STATUSES = ["completed", "failed", "cancelled"] as const;
type ActivityItem = { title: string | null; kind: string; status: string; startedAt?: Date | null; createdAt: Date; completedAt?: Date | null; updatedAt?: Date };
export const subagentActivity = (items: ActivityItem[]): string[] => {
  const events = items.flatMap((item) => {
    const name = item.title ?? item.kind;
    const started = { at: (item.startedAt ?? item.createdAt).getTime(), line: `[pending] ${name}` };
    if (!(FINISHED_ITEM_STATUSES as readonly string[]).includes(item.status)) return [started];
    const ended = (item.completedAt ?? item.updatedAt ?? item.createdAt).getTime();
    return [started, { at: Math.max(ended, started.at), line: `[${item.status === "completed" ? "done" : "failed"}] ${name}` }];
  }).sort((left, right) => left.at - right.at);
  const lines: string[] = [];
  for (const { line } of events) if (lines.at(-1) !== line) lines.push(line);
  return lines.slice(-ACTIVITY_ENTRIES);
};

/** A browser task that names a site with known pitfalls carries that site's notes. */
export const subagentTaskContent = (input: TaskInput, type: SubagentType = input.subagent_type ?? "executor"): string =>
  type === "computerUse" ? withSiteDispatchNotes(input.prompt) : input.prompt;

/** A task or resume opens the worker's turn like a typed message: the reference's <timestamp> and <user_query>. */
export const subagentTaskWake = (input: TaskInput, type?: SubagentType) => ({
  content: subagentTaskContent(input, type),
});

const STEER_HEADER = "[Steering message from the parent agent that dispatched you]";

export const subagentSteerPrompt = (message: string): string =>
  [
    STEER_HEADER,
    message.trim(),
    "Take this into account and continue your task from where you are. Do not start over.",
  ].join("\n\n");

const withEarlierInput = (earlier: string, steer: string): string => (earlier.trim() ? `${earlier}\n\n${steer}` : steer);
/** A pending steer's content without its message, keeping undelivered input carried ahead of it. */
const withoutLatestSteer = (content: string): string => {
  const at = content.lastIndexOf(STEER_HEADER);
  return at < 0 ? content : content.slice(0, at).trimEnd();
};

export const botSubagentId = (id: string): string =>
  id.startsWith("sand-subagent-") ? id : `sand-subagent-${id}`;

export const openteamSubagentId = (id: string): string => id.replace(/^sand-subagent-/, "");

const agentIdLine = (id: string) =>
  `Agent ID: ${botSubagentId(id)} (can be used with the \`resume\` parameter to send a follow-up after it completes)`;

export const subagentBackgroundResult = (id: string): string =>
  `Subagent is running in the background. When you end your turn, you will be automatically sent the subagent's final response upon its completion, so do not wait for it - either end your turn or work on something else.\nDo NOT try to predict the subagent's response before it replies.\n\n${agentIdLine(id)}`;

const failedTaskMessage = (status: string, error: Prisma.JsonValue | null): string => {
  const message = error && typeof error === "object" && !Array.isArray(error) && typeof error.message === "string" ? error.message : undefined;
  return `Error: ${message ?? (status === "stopped" ? "The subagent was stopped before it finished." : "The subagent failed before it finished.")}`;
};

type SubagentDatabase = PrismaClient | Prisma.TransactionClient;

export const assertSubagentCapacity = async (
  parentBotId: string,
  type: SubagentType,
  database: SubagentDatabase
): Promise<void> => {
  if (type !== "computerUse") return;
  const activeComputerUse = await database.subagent.count({
    where: {
      parentBotId,
      subagentType: "computerUse",
      status: { in: [...ACTIVE_STATUSES] },
    },
  });
  if (activeComputerUse > 0) {
    throw new ApiError(
      409,
      "subagent_computer_in_use",
      "A computerUse subagent is already using the box's desktop. Only one can run at a time. Wait for it to finish (you're notified automatically), then dispatch another."
    );
  }
};

export class SubagentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly runs: RunService,
    private readonly workspaceRoot: string,
    private readonly computerFetch: ComputerFetch,
    private readonly agentData: AgentDataStore
  ) {}

  /** As in the reference, every Task runs in the background whatever run_in_background says. */
  async task(context: ToolContext, input: TaskInput) {
    const nested = await this.prisma.subagent.findUnique({ where: { childBotId: context.botId } });
    if (nested) {
      throw new ApiError(403, "nested_subagent_forbidden", "Subagents cannot launch subagents");
    }
    const scope = `subagent-task:${context.botId}`;
    const requestHash = hashRequest(input);
    let receipt = await this.prisma.idempotencyRecord.findUnique({
      where: { scope_key: { scope, key: context.callId } },
    });
    if (receipt && receipt.requestHash !== requestHash) {
      throw new ApiError(409, "idempotency_conflict", "This Task call id was reused");
    }
    const replayId = this.receiptSubagentId(receipt?.response);
    let attempt = receipt ? await this.attemptForCall(context.botId, context.callId) : null;
    let subagent = attempt
      ? await this.owned(context.botId, attempt.subagentId)
      : replayId
        ? await this.owned(context.botId, replayId)
        : null;
    if (!subagent && receipt) {
      throw new ApiError(409, "request_in_progress", "This Task call is already being accepted");
    }
    // A dispatch that asks for steps only the parent can do says so in the result.
    const notice = parentOnlyDispatchNotice({ subagentType: input.subagent_type ?? (input.resume ? undefined : "executor"), prompt: input.prompt });
    const dispatched = (result: string) => (notice ? `${result}\n\n${notice}` : result);
    if (!receipt) {
      try {
        receipt = await this.prisma.idempotencyRecord.create({
          data: {
            scope,
            key: context.callId,
            requestHash,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
          },
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
        throw new ApiError(409, "request_in_progress", "This Task call is already being accepted");
      }
    }
    if (!subagent) {
      try {
        const accepted = input.resume
          ? await this.resume(context, input)
          : await this.launch(context, input);
        subagent = accepted.subagent;
        attempt = accepted.attempt;
        await this.prisma.idempotencyRecord.update({
          where: { scope_key: { scope, key: context.callId } },
          data: {
            status: "completed",
            response: toJson({ subagentId: subagent.id, attemptId: accepted.attempt.id }),
          },
        });
      } catch (error) {
        await this.prisma.idempotencyRecord.deleteMany({
          where: { scope, key: context.callId, status: "processing" },
        });
        throw error;
      }
    }
    attempt ??= await this.attemptForCall(context.botId, context.callId);
    if (!attempt) {
      throw new ApiError(409, "subagent_attempt_missing", "This Task attempt is unavailable");
    }
    return dispatched(subagentBackgroundResult(subagent.id));
  }

  private receiptSubagentId(response: Prisma.JsonValue | null | undefined): string | null {
    return response &&
      typeof response === "object" &&
      !Array.isArray(response) &&
      typeof (response as Record<string, unknown>).subagentId === "string"
      ? ((response as Record<string, unknown>).subagentId as string)
      : null;
  }

  async check(parentBotId: string, input: CheckSubagentInput) {
    if (!input.subagent_id) {
      const running = await this.prisma.subagent.findMany({
        where: { parentBotId, status: { in: [...ACTIVE_STATUSES] } },
        orderBy: { createdAt: "asc" },
      });
      if (running.length === 0) return "No background subagents are running right now.";
      return { subagents: await Promise.all(running.map((subagent) => this.inspect(subagent))) };
    }
    const subagent = await this.runningOwned(parentBotId, input.subagent_id);
    if (typeof subagent === "string") return subagent;
    return this.inspect(subagent);
  }

  /**
   * As in the reference, a parent's message interrupts the running worker turn; the worker
   * then runs a new turn with the message. A message that arrives while that turn is still
   * waiting replaces it, as the reference keeps only the latest pending one. Input the cut-off
   * turn never delivered to the model (the task itself, early on) goes ahead of the message.
   */
  async message(parentBotId: string, callId: string, input: MessageSubagentInput) {
    const subagent = await this.runningOwned(parentBotId, input.subagent_id);
    if (typeof subagent === "string") return subagent;
    const currentRunId = subagent.currentRunId;
    if (subagent.status !== "running" || !currentRunId) return this.noRunningSubagentMessage(parentBotId, input.subagent_id);
    const steer = subagentSteerPrompt(input.message);
    const dispatch = await this.prisma.$transaction(async (tx) => {
      // Serialized with the worker's claim, so a pending turn is never rewritten after the worker read it.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bot-run-claim:${subagent.childBotId}`}))`;
      const run = await tx.run.findUnique({ where: { id: currentRunId } });
      if (!run || !["queued", "running"].includes(run.status)) return null;
      const attempt = await tx.subagentAttempt.findUnique({ where: { childRunId: run.id } });
      if (!attempt) return null;
      // Locks the row against a racing completion; a worker that finished or moved on gets nothing.
      const current = await tx.subagent.updateMany({ where: { id: subagent.id, currentRunId: run.id, status: "running" }, data: { currentRunId: run.id } });
      if (current.count === 0) return null;
      const accepted = (runId: string, interruptedRunId: string | null) =>
        appendEvent(tx, "subagent.message_accepted", subagent.id, { parentBotId, subagentId: subagent.id, runId, interruptedRunId, callId });
      const undelivered = run.inputDeliveredAt ? null : await tx.inboxEvent.findFirst({ where: { runId: run.id } });
      const payload = (undelivered?.payload ?? {}) as Record<string, unknown> & { content?: unknown; messageId?: unknown };
      const earlier = typeof payload.content === "string" ? payload.content : "";
      if (undelivered?.type === "subagent.steer" && undelivered.status === "pending") {
        const content = withEarlierInput(withoutLatestSteer(earlier), steer);
        const replaced = await tx.inboxEvent.updateMany({ where: { id: undelivered.id, status: "pending" }, data: { payload: { ...payload, content } as Prisma.InputJsonObject } });
        if (replaced.count > 0) {
          // The child's transcript shows the message the model gets.
          if (typeof payload.messageId === "string") await tx.message.update({ where: { id: payload.messageId }, data: { content } });
          await accepted(run.id, null);
          return { runId: run.id, interruptRunId: null };
        }
      }
      const channelId = run.channelId;
      if (!channelId) return null;
      const wake = await this.messaging.enqueueWake(tx, {
        botId: subagent.childBotId,
        channelId,
        origin: "agent",
        type: "subagent.steer",
        content: withEarlierInput(earlier, steer),
        wrapUserContent: false,
        clientId: `subagent-steer:${callId}`,
        priority: 350,
      });
      await tx.subagentAttempt.update({ where: { id: attempt.id }, data: { childRunId: wake.run.id } });
      await tx.subagent.update({ where: { id: subagent.id }, data: { currentRunId: wake.run.id } });
      await accepted(wake.run.id, run.id);
      return { runId: wake.run.id, interruptRunId: run.id };
    });
    if (!dispatch) return this.noRunningSubagentMessage(parentBotId, input.subagent_id);
    if (dispatch.interruptRunId) await this.interruptForMessage(dispatch.interruptRunId);
    return { delivered: true, subagent_id: botSubagentId(subagent.id), run_id: dispatch.runId };
  }

  /** The worker turn a parent's message superseded stops; its cut-off calls say they were interrupted. */
  private async interruptForMessage(runId: string): Promise<void> {
    const run = await this.prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
    if (run?.status === "running")
      await this.computerFetch(COMPUTER_API_PATHS.turnCancel(runId), {
        method: "POST",
        body: JSON.stringify({ reason: "parent_message" }),
      }).catch(() => undefined);
    await this.prisma.run.updateMany({
      where: { id: runId, status: { in: ["queued", "running"] } },
      data: { status: "cancelled", error: { code: "superseded_by_parent", message: "Steering message from the parent agent." } },
    });
  }

  /**
   * The user stopping a run, as the reference's agent-run interrupt: a worker's turn stops that
   * worker (its shells end and it won't report back, as with StopSubagent); a bot's turn stops
   * along with every subagent the bot has running.
   */
  stopRun = (runId: string) =>
    serviceEffect(async () => {
      const run = await this.prisma.run.findUnique({ where: { id: runId }, select: { botId: true, status: true } });
      if (!run) throw new ApiError(404, "run_not_found", "Run not found");
      const callId = `user-stop:${runId}`;
      const worker = await this.prisma.subagent.findFirst({
        where: { childBotId: run.botId, currentRunId: runId, status: { in: [...ACTIVE_STATUSES] } },
      });
      if (worker) {
        await this.stopOne(worker.parentBotId, callId, worker);
        const current = await this.prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
        return { ok: true, status: current?.status ?? "cancelled" };
      }
      const result = await Effect.runPromise(this.runs.cancel(runId));
      if (["queued", "running"].includes(run.status)) await this.stopRunningSubagents(run.botId, callId);
      return result;
    });

  /**
   * The reference's escape from a pending update: every turn the bot has queued or running stops
   * as the user's stop above, then every subagent it still has running, so nothing reports back
   * or is redone. Nothing is posted to the chat.
   */
  stopBot = (botId: string) =>
    serviceEffect(async () => {
      const bot = await this.prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
      if (!bot) throw new ApiError(404, "bot_not_found", "Bot not found");
      const runs = await this.prisma.run.findMany({
        where: { botId, status: { in: ["queued", "running"] } },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      await Promise.allSettled(runs.map((run) => Effect.runPromise(this.stopRun(run.id))));
      const workers = await this.stopRunningSubagents(botId, `user-stop:bot:${botId}`);
      return { hadActiveRun: runs.length > 0 || workers.length > 0 };
    });

  /**
   * The bots with work in progress, longest-running first, which an update waits for. A subagent's
   * turn counts for the bot that launched it, as the user can only stop that bot.
   */
  busyBots = () =>
    serviceEffect(async (): Promise<BusyBotsView> => {
      const [runs, subagents] = await Promise.all([
        this.prisma.run.findMany({
          where: { status: { in: ["queued", "running"] } },
          select: { id: true, botId: true },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.subagent.findMany({
          where: { status: { in: [...ACTIVE_STATUSES] } },
          select: { childBotId: true },
          orderBy: { createdAt: "asc" },
        }),
      ]);
      const parentOf = new Map<string, string>();
      let unresolved = [...new Set([...runs.map((run) => run.botId), ...subagents.map((row) => row.childBotId)])];
      while (unresolved.length > 0) {
        const links = await this.prisma.subagent.findMany({
          where: { childBotId: { in: unresolved } },
          select: { childBotId: true, parentBotId: true },
        });
        for (const link of links) parentOf.set(link.childBotId, link.parentBotId);
        unresolved = links.map((link) => link.parentBotId).filter((id) => !parentOf.has(id));
      }
      const root = (botId: string) => {
        let id = botId;
        for (let depth = 0; parentOf.has(id) && depth < 16; depth++) id = parentOf.get(id)!;
        return id;
      };
      const runIds = new Map<string, string[]>();
      for (const run of runs) runIds.set(root(run.botId), [...(runIds.get(root(run.botId)) ?? []), run.id]);
      for (const row of subagents) if (!runIds.has(root(row.childBotId))) runIds.set(root(row.childBotId), []);
      const names = new Map(
        (await this.prisma.bot.findMany({ where: { id: { in: [...runIds.keys()] } }, select: { id: true, name: true } }))
          .map((bot) => [bot.id, bot.name]),
      );
      return {
        bots: [...runIds].map(([botId, ids]) => ({ botId, name: names.get(botId) ?? "", runIds: ids })),
      };
    });

  async stop(parentBotId: string, callId: string, input: StopSubagentInput) {
    if (input.all === true) return this.stopAll(parentBotId, callId);
    const subagent = await this.runningOwned(parentBotId, input.subagent_id);
    if (typeof subagent === "string") return subagent;
    const result = await this.stopOne(parentBotId, callId, subagent);
    // A subagent that finished before the stop reached it is no longer running.
    return result.stopped || (ACTIVE_STATUSES as readonly string[]).includes(result.status) ? result : this.noRunningSubagentMessage(parentBotId, input.subagent_id);
  }

  /** Stop each running subagent on its own, so one failure never hides or blocks the others. */
  private async stopAll(parentBotId: string, callId: string) {
    const [outcomes, delegated] = await Promise.all([this.stopRunningSubagents(parentBotId, callId), this.stopDelegatedWork(parentBotId, callId)]);
    const of = (outcome: string) => outcomes.filter((entry) => entry.outcome === outcome).map(({ outcome: _, ...entry }) => entry);
    return { stopped_all: true, stopped: of("stopped"), already_finished: of("finished"), failed: of("failed"), delegated };
  }

  private async stopRunningSubagents(parentBotId: string, callId: string) {
    const running = await this.prisma.subagent.findMany({
      where: { parentBotId, status: { in: [...ACTIVE_STATUSES] } },
      orderBy: { createdAt: "asc" },
    });
    return Promise.all(running.map(async (subagent) => {
      const summary = { subagent_id: botSubagentId(subagent.id), subagent_type: subagent.subagentType, title: subagentTitle(subagent.prompt) };
      try {
        const result = await this.stopOne(parentBotId, callId, subagent);
        if (result.stopped) return { ...summary, outcome: "stopped" as const };
        return (ACTIVE_STATUSES as readonly string[]).includes(result.status)
          ? { ...summary, outcome: "failed" as const, error: "it started a new attempt while the stop was in flight" }
          : { ...summary, outcome: "finished" as const };
      } catch (error) {
        return { ...summary, outcome: "failed" as const, error: error instanceof Error ? error.message : String(error) };
      }
    }));
  }

  /**
   * Peers this agent handed work to with a priority message in the last day: a turn that message
   * started and is still going is cancelled, with the subagents it dispatched; any other peer is idle.
   */
  private async stopDelegatedWork(parentBotId: string, callId: string) {
    const sent = await this.prisma.channelMessage.findMany({
      where: { senderBotId: parentBotId, clientId: { startsWith: A2A_OUTGOING_PREFIX }, createdAt: { gte: new Date(Date.now() - DELEGATED_WORK_WINDOW_MS) } },
      select: { clientId: true, metadata: true },
      orderBy: { createdAt: "desc" },
    });
    const handoffs = sent.flatMap(({ clientId, metadata }) => {
      const peer = (metadata as { toAgent?: { id?: unknown; name?: unknown } } | null)?.toAgent;
      return clientId && typeof peer?.id === "string"
        ? [{ key: `agent:${clientId.slice(A2A_OUTGOING_PREFIX.length)}:${peer.id}`, id: peer.id, name: typeof peer.name === "string" ? peer.name : peer.id }]
        : [];
    });
    if (!handoffs.length) return [];
    // A priority message's wake carries the urgent priority and starts the peer's turn on it; a
    // turn a typed message cut off runs again under `<key>:redrive:N`, and the newest one counts.
    const wakes = await this.prisma.inboxEvent.findMany({
      where: {
        OR: handoffs.flatMap(({ key }) => [{ idempotencyKey: key }, { idempotencyKey: { startsWith: `${key}:redrive:` } }]),
        priority: PRIORITY.urgentAgent,
      },
      select: { idempotencyKey: true, runId: true },
      orderBy: { createdAt: "desc" },
    });
    const peers = new Map<string, { id: string; name: string; runId: string | null }>();
    for (const handoff of handoffs) {
      const wake = wakes.find(({ idempotencyKey: key }) => key === handoff.key || key?.startsWith(`${handoff.key}:redrive:`));
      if (wake && !peers.has(handoff.id)) peers.set(handoff.id, { id: handoff.id, name: handoff.name, runId: wake.runId });
    }
    return Promise.all([...peers.values()].map(async (peer) => {
      const run = peer.runId ? await this.prisma.run.findUnique({ where: { id: peer.runId }, select: { status: true } }) : null;
      if (!peer.runId || !run || !["queued", "running"].includes(run.status)) return { id: peer.id, name: peer.name, result: "not_running" as const };
      try {
        await Effect.runPromise(this.runs.cancel(peer.runId));
        const dispatched = await this.prisma.subagent.findMany({ where: { parentBotId: peer.id, parentRunId: peer.runId, status: { in: [...ACTIVE_STATUSES] } } });
        await Promise.all(dispatched.map((subagent) => this.stopOne(peer.id, callId, subagent)));
        return { id: peer.id, name: peer.name, result: "stopped" as const };
      } catch (error) {
        return { id: peer.id, name: peer.name, result: "failed" as const, detail: error instanceof Error ? error.message : String(error) };
      }
    }));
  }

  private async stopOne(parentBotId: string, callId: string, subagent: Awaited<ReturnType<SubagentService["owned"]>>) {
    if (subagent.currentRunId) {
      try {
        await Effect.runPromise(this.runs.cancel(subagent.currentRunId));
      } catch (error) {
        // A completed run can race cancellation. Transport failures for a live
        // run must remain failures so the caller can retry the same worker.
        const run = await this.prisma.run.findUnique({ where: { id: subagent.currentRunId } });
        if (!run || !["completed", "failed", "cancelled", "interrupted"].includes(run.status)) throw error;
      }
    }
    // Before the stop is recorded, so a failure leaves it running and retryable.
    await stopSubagentShells(this.computerFetch, subagent.childBotId);
    const stopped = await this.prisma.$transaction(async (tx) => {
      const stoppedAt = new Date();
      const updated = await tx.subagent.updateMany({
        where: {
          id: subagent.id,
          currentRunId: subagent.currentRunId,
          status: { in: [...ACTIVE_STATUSES] },
        },
        data: { status: "stopped", stoppedAt, completedAt: stoppedAt },
      });
      // Do not overwrite completion or a new attempt that began while the
      // cancellation request was in flight.
      if (updated.count === 0) return false;
      if (subagent.currentRunId) {
        await tx.subagentAttempt.updateMany({
          where: {
            subagentId: subagent.id,
            childRunId: subagent.currentRunId,
            status: { in: ["provisioning", "queued", "running"] },
          },
          data: { status: "stopped", stoppedAt, completedAt: stoppedAt },
        });
      }
      await appendEvent(tx, "subagent.stopped", subagent.id, {
        parentBotId,
        subagentId: subagent.id,
        runId: subagent.currentRunId,
        callId,
      });
      return true;
    });
    if (!stopped) {
      const current = await this.prisma.subagent.findUnique({ where: { id: subagent.id } });
      // The worker may record the cancelled turn as stopped before this transaction does.
      if (current?.status === "stopped" && current.currentRunId === subagent.currentRunId)
        return { stopped: true, subagent_id: botSubagentId(subagent.id), status: "stopped" };
      return { stopped: false, subagent_id: botSubagentId(subagent.id), status: current?.status ?? "unavailable" };
    }
    return { stopped: true, subagent_id: botSubagentId(subagent.id), status: "stopped" };
  }

  private async launch(context: ToolContext, input: TaskInput, restoredId?: string) {
    const [configuredInference, currentConfig, parentRun] = await Promise.all([
      this.agentData.loadInferenceSettings(),
      this.agentData.loadTaskConfiguration(),
      this.prisma.run.findUnique({ where: { id: context.runId } }),
    ]);
    const config = parentRun?.taskConfiguration ? parseTaskConfiguration(parentRun.taskConfiguration) : currentConfig;
    const type = input.subagent_type ?? "executor";
    if (type === "computerUse" && config.graphicalAvailable === false)
      throw new ApiError(409, "graphical_worker_unavailable", "Browser and desktop workers are unavailable on this computer.");
    const inherited = { ...configuredInference,
      ...(parentRun?.inferenceProvider && parentRun.inferenceModel ? {
        providerId: parentRun.inferenceProvider, modelId: parentRun.inferenceModel,
        reasoning: parentRun.inferenceReasoning ? normalizePiReasoningLevel(parentRun.inferenceReasoning) : configuredInference.reasoning,
      } : {}),
    };
    let selectedInference;
    try { selectedInference = taskInference(config, input, inherited); }
    catch (error) { throw new ApiError(400, "invalid_executor_profile", (error as Error).message); }
    const selectedModel = formatPiModelRef(selectedInference);
    const parent = await this.prisma.bot.findUnique({ where: { id: context.botId } });
    if (!parent || parent.status !== "active") {
      throw new ApiError(409, "parent_not_active", "The parent agent is not active");
    }
    const subagentId =
      restoredId && /^[0-9a-f-]{36}$/i.test(restoredId) ? restoredId : crypto.randomUUID();
    const childBotId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const name = input.description.trim() || "Background task";
    const directory = this.workspaceRoot;
    const outputPath = `/home/box/agent-data/agent-transcripts/${childBotId}/${childBotId}.jsonl`;
    const avatar = resolveBotAvatarMark({ agentId: childBotId });
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('openteam-subagent-capacity'))`;
      await assertSubagentCapacity(context.botId, type, tx);
      await tx.bot.create({
        data: {
          id: childBotId,
          name,
          title: `Subagent (${type})`,
          description: `Background subagent owned by ${parent.name}`,
          instructions: "",
          icon: avatar.shape,
          color: avatar.color,
          notificationsEnabled: false,
          hiddenFromSidebar: true,
          defaultDirectory: directory,
          status: "provisioning",
          onboardingStatus: "skipped_by_user",
          onboardingCompletedAt: new Date(),
          conversation: { create: { id: conversationId } },
        },
      });
      await tx.channel.create({
        data: {
          id: channelId,
          kind: "bot_dm",
          name,
          directKey: `bot:${childBotId}`,
          members: { create: { botId: childBotId, ordinal: 0 } },
        },
      });
      const created = await tx.subagent.create({
        data: {
          id: subagentId,
          parentBotId: context.botId,
          childBotId,
          parentRunId: context.runId,
          parentChannelId: context.channelId,
          launchCallId: context.callId,
          description: name,
          prompt: input.prompt,
          subagentType: type,
          model: selectedModel,
          reasoning: selectedInference.reasoning,
          taskConfiguration: toJson(config),
          fileAttachments: (input.file_attachments ?? []) as Prisma.InputJsonValue,
          readOnly: input.read_only ?? false,
          outputPath,
        },
      });
      const wake = await this.messaging.enqueueWake(tx, {
        botId: childBotId,
        channelId,
        origin: "agent",
        type: "subagent.task",
        ...subagentTaskWake(input),
        clientId: `subagent:${subagentId}:initial`,
        priority: 350,
      });
      const updated = await tx.subagent.update({
        where: { id: created.id },
        data: { currentRunId: wake.run.id },
      });
      const attempt = await tx.subagentAttempt.create({
        data: {
          subagentId,
          parentRunId: context.runId,
          parentChannelId: context.channelId,
          parentToolCallId: context.callId,
          childRunId: wake.run.id,
          description: name,
          prompt: input.prompt,
          fileAttachments: (input.file_attachments ?? []) as Prisma.InputJsonValue,
          status: "provisioning",
        },
      });
      await appendEvent(tx, "subagent.created", subagentId, {
        parentBotId: context.botId,
        parentRunId: context.runId,
        childBotId,
        runId: wake.run.id,
        type,
      });
      await this.messaging.boss.send(
        "bot-provision",
        { botId: childBotId },
        {
          db: fromPrisma(tx),
          retryLimit: 8,
          retryDelay: 2,
          retryBackoff: true,
          expireInSeconds: 3 * 60,
        }
      );
      return { subagent: updated, attempt };
    });
  }

  private async resume(context: ToolContext, input: TaskInput) {
    if (!input.resume) throw new ApiError(400, "resume_id_required", "resume is required");
    const restoredId = openteamSubagentId(input.resume);
    const subagent = await this.prisma.subagent.findFirst({
      where: { id: restoredId, parentBotId: context.botId },
    });
    if (!subagent) {
      return this.launch(context, { ...input, resume: undefined }, restoredId);
    }
    const type = Schema.decodeUnknownSync(SubagentType)(subagent.subagentType);
    if (input.subagent_type !== undefined && normalizeSubagentTypeName(input.subagent_type) !== normalizeSubagentTypeName(type)) {
      throw new ApiError(
        409,
        "subagent_type_mismatch",
        `Cannot resume a "${type}" subagent as "${input.subagent_type}". A resumed subagent keeps its type: omit \`subagent_type\` to resume this child, or start a new "${input.subagent_type}" subagent without \`resume\`.`
      );
    }
    if (["provisioning", "queued", "running"].includes(subagent.status)) {
      throw new ApiError(
        409,
        "subagent_not_resumable",
        "That background subagent is still running, so it can't be resumed yet. You're notified automatically when it finishes. To act on it while it runs, use MessageSubagent to send it an instruction or StopSubagent to abort it (CheckSubagent shows how it's doing)."
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('openteam-subagent-capacity'))`;
      await assertSubagentCapacity(context.botId, type, tx);
      const child = await tx.bot.findUnique({
        where: { id: subagent.childBotId },
        include: {
          conversation: true,
          channelMemberships: { where: { channel: { kind: "bot_dm" } } },
        },
      });
      const channelId = child?.channelMemberships[0]?.channelId;
      if (!child?.conversation || child.status !== "active" || !channelId) {
        throw new ApiError(
          409,
          "subagent_unavailable",
          "The prior subagent runtime is unavailable"
        );
      }
      const wake = await this.messaging.enqueueWake(tx, {
        botId: child.id,
        channelId,
        origin: "agent",
        type: "subagent.resume",
        ...subagentTaskWake(input, type),
        clientId: `subagent:${subagent.id}:resume:${context.callId}`,
        priority: 350,
      });
      const description = input.description.trim() || subagent.description;
      const attempt = await tx.subagentAttempt.create({
        data: {
          subagentId: subagent.id,
          parentRunId: context.runId,
          parentChannelId: context.channelId,
          parentToolCallId: context.callId,
          childRunId: wake.run.id,
          description,
          prompt: input.prompt,
          fileAttachments: (input.file_attachments ?? []) as Prisma.InputJsonValue,
          status: "queued",
        },
      });
      const updated = await tx.subagent.update({
        where: { id: subagent.id },
        data: {
          parentRunId: context.runId,
          parentChannelId: context.channelId,
          launchCallId: context.callId,
          currentRunId: wake.run.id,
          description,
          prompt: input.prompt,
          fileAttachments: (input.file_attachments ?? []) as Prisma.InputJsonValue,
          status: "queued",
          result: null,
          error: Prisma.DbNull,
          startedAt: null,
          completedAt: null,
          stoppedAt: null,
        },
      });
      await appendEvent(tx, "subagent.resumed", subagent.id, {
        parentBotId: context.botId,
        parentRunId: context.runId,
        runId: wake.run.id,
      });
      return { subagent: updated, attempt };
    });
  }

  private async owned(parentBotId: string, id: string) {
    const subagent = await this.prisma.subagent.findFirst({
      where: { id: openteamSubagentId(id), parentBotId },
    });
    if (!subagent) throw new ApiError(404, "subagent_not_found", "Subagent not found");
    return subagent;
  }

  /** A running subagent of this parent, or the reference's not-running answer, which is an ordinary result. */
  private async runningOwned(parentBotId: string, id: string) {
    const subagent = await this.prisma.subagent.findFirst({
      where: {
        id: openteamSubagentId(id),
        parentBotId,
        status: { in: [...ACTIVE_STATUSES] },
      },
    });
    return subagent ?? this.noRunningSubagentMessage(parentBotId, id);
  }

  private async noRunningSubagentMessage(parentBotId: string, id: string): Promise<string> {
    const running = await this.prisma.subagent.findMany({
      where: { parentBotId, status: { in: [...ACTIVE_STATUSES] } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    const suffix = running.length
      ? ` Currently running: ${running.map(({ id: candidate }) => botSubagentId(candidate)).join(", ")}.`
      : " No subagents are running right now.";
    return `No subagent "${botSubagentId(openteamSubagentId(id))}" is currently running. It may have already finished (you're revived automatically with a finished subagent's result), or the id is wrong.${suffix}`;
  }

  private attemptForCall(parentBotId: string, parentToolCallId: string) {
    return this.prisma.subagentAttempt.findFirst({
      where: { parentToolCallId, subagent: { parentBotId } },
    });
  }

  private async inspect(subagent: Awaited<ReturnType<SubagentService["owned"]>>) {
    const currentRun = subagent.currentRunId
      ? await this.prisma.run.findFirst({
          where: { id: subagent.currentRunId, botId: subagent.childBotId },
          select: { id: true, status: true },
        })
      : null;
    // Prompt fingerprints are persisted as tool-kind diagnostics, not agent actions.
    // Filter before the recent-call limit so diagnostics cannot hide real activity.
    const activityWhere: Prisma.RunItemWhereInput = {
      runId: currentRun?.id,
      kind: { in: ["command", "file_change", "tool"] },
      OR: [
        { kind: { not: "tool" } },
        { title: null },
        { title: { not: "promptFingerprint" } },
      ],
    };
    const recentItems = currentRun
      ? await this.prisma.runItem.findMany({
          where: activityWhere,
          orderBy: { createdAt: "desc" },
          take: ACTIVITY_ENTRIES,
        })
      : [];
    const end = subagent.completedAt ?? subagent.stoppedAt ?? new Date();
    return {
      subagent_id: botSubagentId(subagent.id),
      title: subagentTitle(subagent.prompt),
      subagent_type: subagent.subagentType,
      status: subagent.status,
      run_status: currentRun?.status ?? null,
      elapsed_seconds: Math.max(
        0,
        Math.round((end.getTime() - (subagent.startedAt ?? subagent.createdAt).getTime()) / 1_000)
      ),
      // Like the reference, the count covers calls that have finished.
      tool_call_count: currentRun ? await this.prisma.runItem.count({ where: { AND: [activityWhere, { status: { in: [...FINISHED_ITEM_STATUSES] } }] } }) : 0,
      recent_activity: subagentActivity(recentItems),
      transcript_path: subagent.outputPath,
      result: subagent.result,
      error: subagent.error,
    };
  }
}
