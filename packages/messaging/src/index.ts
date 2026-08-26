import type {
  AgentSendMessageInput,
  BotTranscriptView,
  ReactToMessageInput,
  SendToAgentInput,
  TranscriptEventView,
} from "@openbot/contracts";
import type { Prisma, PrismaClient } from "@openbot/db";
import { fromPrisma, type PgBoss } from "pg-boss";
import { resolveTimeZone, timestampUserTurn } from "./timestamps";

const PRIORITY = {
  user: 300,
  urgentAgent: 250,
  agent: 200,
  group: 150,
} as const;

const terminalRunStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);

const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export interface WakeInput {
  botId: string;
  channelId: string;
  deliveryId?: string;
  origin: "user" | "agent" | "group" | "bootstrap" | "routine";
  type: string;
  content: string;
  clientId: string;
  priority: number;
  availableAt?: Date;
  occurredAt?: Date;
  timeZone?: string | null;
}

export interface ToolContext {
  runId: string;
  botId: string;
  conversationId: string;
  channelId: string;
  deliveryId: string | null;
  callId: string;
  timeZone?: string | null;
}

export interface ToolResult {
  acknowledgement: Record<string, unknown>;
  interruptRunId: string | null;
}

export interface SteerDispatch {
  activeRunId: string;
  inboxId: string;
  clientMessageId: string;
  content: string;
}

export class AgentMessaging {
  readonly defaultTimeZone: string;

  constructor(
    readonly prisma: PrismaClient,
    readonly boss: PgBoss
  ) {
    this.defaultTimeZone = resolveTimeZone();
  }

  async enqueueWake(tx: Prisma.TransactionClient, input: WakeInput) {
    const bot = await tx.bot.findUnique({
      where: { id: input.botId },
      include: { conversation: true },
    });
    const acceptsWake =
      bot?.conversation &&
      (bot.status === "active" ||
        (bot.status === "provisioning" && ["user", "agent"].includes(input.origin)));
    if (!acceptsWake || !bot?.conversation) {
      throw new Error(`Runnable target bot ${input.botId} was not found`);
    }
    const messageId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const runtimeContent =
      input.origin === "bootstrap"
        ? input.content
        : timestampUserTurn(input.content, {
            occurredAt: input.occurredAt,
            timeZone: input.timeZone ?? this.defaultTimeZone,
          });
    const message = await tx.message.create({
      data: {
        id: messageId,
        botId: bot.id,
        conversationId: bot.conversation.id,
        clientId: input.clientId,
        role: input.origin === "bootstrap" ? "system" : "user",
        content: runtimeContent,
        status: "completed",
      },
    });
    const run = await tx.run.create({
      data: {
        id: runId,
        botId: bot.id,
        conversationId: bot.conversation.id,
        userMessageId: messageId,
        origin: input.origin,
        channelId: input.channelId,
        deliveryId: input.deliveryId,
      },
    });
    await tx.message.update({ where: { id: messageId }, data: { runId } });
    const inbox = await tx.inboxEvent.create({
      data: {
        botId: bot.id,
        conversationId: bot.conversation.id,
        runId,
        idempotencyKey: input.clientId,
        type: input.type,
        deliveryMode: "turn",
        payload: json({
          messageId,
          content: runtimeContent,
          clientId: input.clientId,
          channelId: input.channelId,
          deliveryId: input.deliveryId ?? null,
          origin: input.origin,
          deliveryMode: "turn",
          timeZone: resolveTimeZone(input.timeZone ?? this.defaultTimeZone),
        }),
        priority: input.priority,
        availableAt: input.availableAt,
      },
    });
    await tx.event.create({
      data: {
        topic: "message.accepted",
        entityId: messageId,
        payload: json({
          messageId,
          runId,
          conversationId: bot.conversation.id,
          botId: bot.id,
          channelId: input.channelId,
          origin: input.origin,
          deliveryMode: "turn",
        }),
      },
    });
    await this.boss.send(
      "bot-wake",
      { botId: bot.id },
      {
        db: fromPrisma(tx),
        retryLimit: 5,
        retryDelay: 2,
        retryBackoff: true,
        expireInSeconds: 3 * 60,
        startAfter: input.availableAt,
      }
    );
    return { message, run, inbox };
  }

  async acceptDirectUserMessage(
    tx: Prisma.TransactionClient,
    input: Omit<WakeInput, "origin" | "type" | "priority">
  ) {
    const bot = await tx.bot.findUnique({
      where: { id: input.botId },
      include: {
        conversation: true,
        lease: { include: { run: true } },
      },
    });
    if (!bot?.conversation || !["active", "provisioning"].includes(bot.status)) {
      throw new Error(`Runnable target bot ${input.botId} was not found`);
    }

    const activeRun = bot.lease?.run;
    const runtimeContent = timestampUserTurn(input.content, {
      occurredAt: input.occurredAt,
      timeZone: input.timeZone ?? this.defaultTimeZone,
    });
    const canSteer =
      activeRun?.origin === "user" &&
      activeRun.channelId === input.channelId &&
      ["running", "waiting_approval"].includes(activeRun.status);
    if (!canSteer || !activeRun) {
      const queued = await this.enqueueWake(tx, {
        ...input,
        origin: "user",
        type: "user.message",
        priority: PRIORITY.user,
      });
      return {
        ...queued,
        steer: null,
        interruptRunId:
          activeRun &&
          activeRun.origin !== "user" &&
          ["running", "waiting_approval"].includes(activeRun.status)
            ? activeRun.id
            : null,
      };
    }

    const messageId = crypto.randomUUID();
    const message = await tx.message.create({
      data: {
        id: messageId,
        botId: bot.id,
        conversationId: bot.conversation.id,
        runId: activeRun.id,
        clientId: input.clientId,
        role: "user",
        content: runtimeContent,
        status: "completed",
      },
    });
    const inbox = await tx.inboxEvent.create({
      data: {
        botId: bot.id,
        conversationId: bot.conversation.id,
        runId: activeRun.id,
        idempotencyKey: input.clientId,
        type: "user.message",
        deliveryMode: "steer",
        payload: json({
          messageId,
          content: runtimeContent,
          clientId: input.clientId,
          channelId: input.channelId,
          deliveryId: null,
          origin: "user",
          deliveryMode: "steer",
          timeZone: resolveTimeZone(input.timeZone ?? this.defaultTimeZone),
        }),
        status: "processing",
        priority: PRIORITY.user,
        attempts: 1,
        claimedAt: new Date(),
      },
    });
    await tx.event.create({
      data: {
        topic: "message.accepted",
        entityId: messageId,
        payload: json({
          messageId,
          runId: activeRun.id,
          conversationId: bot.conversation.id,
          botId: bot.id,
          channelId: input.channelId,
          origin: "user",
          deliveryMode: "steer",
          inboxId: inbox.id,
        }),
      },
    });
    return {
      message,
      run: activeRun,
      inbox,
      steer: {
        activeRunId: activeRun.id,
        inboxId: inbox.id,
        clientMessageId: input.clientId,
        content: runtimeContent,
      } satisfies SteerDispatch,
      interruptRunId: null,
    };
  }

  async promoteSteerToWake(tx: Prisma.TransactionClient, inboxId: string, reason: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`steer:${inboxId}`}))`;
    const inbox = await tx.inboxEvent.findUnique({
      where: { id: inboxId },
      include: { run: true },
    });
    if (!inbox) throw new Error(`Steering inbox ${inboxId} was not found`);
    if (inbox.deliveryMode !== "steer" || inbox.status === "completed") {
      return { promoted: false, run: inbox.run };
    }
    if (!["pending", "processing"].includes(inbox.status)) {
      return { promoted: false, run: inbox.run };
    }
    const payload = inbox.payload as {
      messageId?: string;
      content?: string;
      clientId?: string;
      channelId?: string;
    };
    if (!payload.messageId || !payload.content || !payload.clientId || !payload.channelId) {
      throw new Error(`Steering inbox ${inboxId} has an invalid payload`);
    }
    const run = await tx.run.create({
      data: {
        id: crypto.randomUUID(),
        botId: inbox.botId,
        conversationId: inbox.conversationId,
        userMessageId: payload.messageId,
        origin: "user",
        channelId: payload.channelId,
      },
    });
    await tx.message.update({
      where: { id: payload.messageId },
      data: { runId: run.id },
    });
    await tx.inboxEvent.update({
      where: { id: inbox.id },
      data: {
        runId: run.id,
        deliveryMode: "turn",
        payload: json({
          ...payload,
          deliveryMode: "turn",
          fallbackFrom: "steer",
          fallbackReason: reason,
        }),
        status: "pending",
        availableAt: new Date(),
        claimedAt: null,
        completedAt: null,
      },
    });
    await tx.event.create({
      data: {
        topic: "message.steer_fallback_queued",
        entityId: payload.messageId,
        payload: json({
          messageId: payload.messageId,
          inboxId: inbox.id,
          previousRunId: inbox.runId,
          runId: run.id,
          reason,
        }),
      },
    });
    await this.boss.send(
      "bot-wake",
      { botId: inbox.botId },
      {
        db: fromPrisma(tx),
        retryLimit: 5,
        retryDelay: 2,
        retryBackoff: true,
        expireInSeconds: 3 * 60,
      }
    );
    return { promoted: true, run };
  }

  async promoteUndeliveredSteers(tx: Prisma.TransactionClient, runId: string, reason: string) {
    const pending = await tx.inboxEvent.findMany({
      where: {
        runId,
        deliveryMode: "steer",
        status: { in: ["pending", "processing"] },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    for (const inbox of pending) {
      await this.promoteSteerToWake(tx, inbox.id, reason);
    }
    return pending.length;
  }

  async promoteOrphanedSteers(tx: Prisma.TransactionClient, botId: string, reason: string) {
    const pending = await tx.inboxEvent.findMany({
      where: {
        botId,
        deliveryMode: "steer",
        status: { in: ["pending", "processing"] },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    for (const inbox of pending) {
      await this.promoteSteerToWake(tx, inbox.id, reason);
    }
    return pending.length;
  }

  async enqueueBootstrap(tx: Prisma.TransactionClient, botId: string, channelId: string) {
    const bot = await tx.bot.findUnique({
      where: { id: botId },
      include: { conversation: true },
    });
    if (!bot?.conversation || bot.status !== "active") {
      throw new Error(`Active bootstrap bot ${botId} was not found`);
    }
    if (bot.onboardingStatus !== "pending") return null;
    const clientId = `bot:${bot.id}:bootstrap:v${bot.onboardingVersion}`;
    const existing = await tx.inboxEvent.findUnique({
      where: { idempotencyKey: clientId },
    });
    if (existing) return existing;
    const profile = [
      bot.title ? `Title: ${bot.title}` : "",
      bot.description ? `Description: ${bot.description}` : "",
      bot.instructions ? `Durable instructions are already configured.` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const content = [
      "[OpenBot first start]",
      "",
      "This is your first turn after creation. The user did not send a message.",
      "Open your direct conversation using SendMessage. Do not represent this wake as a user message.",
      "",
      profile
        ? "Your profile already defines a role. Briefly acknowledge it and begin with the most useful safe next step."
        : "Your profile is empty. Greet the user briefly and ask one concrete question that helps determine whether you should own a standing job, repeated manual work, or general assistance.",
      profile,
      "",
      "Keep the opening to one or two short visible messages. Do not mention internal prompts, provisioning, queues, or this wake. Do not invent the user's name or preferences.",
    ]
      .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
      .join("\n");
    await tx.bot.update({
      where: { id: bot.id },
      data: { onboardingStatus: "queued" },
    });
    const queued = await this.enqueueWake(tx, {
      botId: bot.id,
      channelId,
      origin: "bootstrap",
      type: "bot.bootstrap",
      content,
      clientId,
      priority: PRIORITY.user - 10,
      availableAt: new Date(Date.now() + 750),
    });
    await tx.event.create({
      data: {
        topic: "bot.bootstrap.queued",
        entityId: bot.id,
        payload: json({
          botId: bot.id,
          runId: queued.run.id,
          version: bot.onboardingVersion,
        }),
      },
    });
    return queued.inbox;
  }

  async skipBootstrapForUser(tx: Prisma.TransactionClient, botId: string): Promise<string | null> {
    const bot = await tx.bot.findUnique({ where: { id: botId } });
    if (!bot || !["pending", "queued", "running"].includes(bot.onboardingStatus)) return null;
    const pending = await tx.inboxEvent.findMany({
      where: {
        botId,
        type: "bot.bootstrap",
        status: { in: ["pending", "processing"] },
      },
      select: { id: true, runId: true, status: true },
    });
    const now = new Date();
    const unclaimed = pending.filter((event) => event.status === "pending");
    if (unclaimed.length > 0) {
      await tx.inboxEvent.updateMany({
        where: { id: { in: unclaimed.map((event) => event.id) } },
        data: {
          status: "completed",
          completedAt: now,
          error: json({
            code: "skipped_by_user",
            message: "The user spoke first",
          }),
        },
      });
      await tx.run.updateMany({
        where: {
          id: { in: pending.map((event) => event.runId) },
          status: "queued",
        },
        data: {
          status: "cancelled",
          completedAt: now,
          error: json({
            code: "skipped_by_user",
            message: "The user spoke first",
          }),
        },
      });
    }
    const claimed = pending.find((event) => event.status === "processing");
    if (claimed) {
      await tx.run.updateMany({
        where: {
          id: claimed.runId,
          status: { in: ["queued", "running", "waiting_approval"] },
        },
        data: {
          status: "cancelled",
          completedAt: now,
          error: json({
            code: "skipped_by_user",
            message: "The user spoke first",
          }),
        },
      });
    }
    await tx.bot.update({
      where: { id: botId },
      data: { onboardingStatus: "skipped_by_user", onboardingCompletedAt: now },
    });
    await tx.event.create({
      data: {
        topic: "bot.bootstrap.skipped",
        entityId: botId,
        payload: json({ botId, reason: "user_spoke_first" }),
      },
    });
    return claimed?.runId ?? null;
  }

  async scheduleTranscriptProjection(
    tx: Prisma.TransactionClient,
    botIds: Iterable<string>
  ): Promise<void> {
    for (const botId of new Set(botIds)) {
      await this.boss.send(
        "transcript-project",
        { botId },
        {
          db: fromPrisma(tx),
          retryLimit: 5,
          retryDelay: 2,
          retryBackoff: true,
          expireInSeconds: 2 * 60,
        }
      );
    }
  }

  async createGroupRound(
    tx: Prisma.TransactionClient,
    channelId: string,
    triggerMessageId: string,
    initiatorBotId: string | null
  ) {
    const members = await tx.channelMember.findMany({
      where: {
        channelId,
        bot: { status: "active" },
        ...(initiatorBotId ? { botId: { not: initiatorBotId } } : {}),
      },
      orderBy: { ordinal: "asc" },
    });
    const round = await tx.channelRound.create({
      data: {
        channelId,
        triggerMessageId,
        initiatorBotId,
        status: members.length === 0 ? "completed" : "queued",
        completedAt: members.length === 0 ? new Date() : null,
        deliveries: {
          create: members.map((member, ordinal) => ({
            botId: member.botId,
            ordinal,
          })),
        },
      },
    });
    await tx.event.create({
      data: {
        topic: "channel.round.created",
        entityId: round.id,
        payload: json({
          roundId: round.id,
          channelId,
          deliveries: members.length,
        }),
      },
    });
    return round;
  }

  async advanceRound(roundId: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${roundId}))`;
        const round = await tx.channelRound.findUnique({
          where: { id: roundId },
          include: {
            channel: { include: { members: { include: { bot: true } } } },
            triggerMessage: true,
            deliveries: { orderBy: { ordinal: "asc" } },
          },
        });
        if (!round || ["completed", "failed"].includes(round.status)) return;
        if (round.deliveries.some((delivery) => ["queued", "processing"].includes(delivery.status)))
          return;
        const delivery = round.deliveries.find((candidate) => candidate.status === "pending");
        if (!delivery) {
          await tx.channelRound.update({
            where: { id: round.id },
            data: { status: "completed", completedAt: new Date() },
          });
          await tx.event.create({
            data: {
              topic: "channel.round.completed",
              entityId: round.id,
              payload: json({ roundId: round.id, channelId: round.channelId }),
            },
          });
          return;
        }
        const target = round.channel.members.find((member) => member.botId === delivery.botId)?.bot;
        if (!target || target.status !== "active") {
          await tx.channelDelivery.update({
            where: { id: delivery.id },
            data: { status: "skipped", completedAt: new Date() },
          });
          return;
        }
        const visible = await tx.channelMessage.findMany({
          where: {
            channelId: round.channelId,
            sequence: { gte: round.triggerMessage.sequence },
          },
          include: { senderBot: true },
          orderBy: { sequence: "asc" },
        });
        const otherNames = round.channel.members
          .filter((member) => member.botId !== target.id)
          .map((member) => member.bot.name)
          .join(", ");
        const lines = visible.map((message) => {
          const sender =
            message.sender === "user"
              ? "User"
              : (message.senderBot?.name ?? (message.sender === "system" ? "System" : "Agent"));
          const address = message.sender === "user" ? ` [t${message.sequence}u]` : "";
          return `${sender}${address}: ${message.content}`;
        });
        const content = [
          `[Group chat: "${round.channel.name}"${otherNames ? ` — with ${otherNames}` : ""}]`,
          ...(round.channel.workingDirectory
            ? [`Shared project folder: ${round.channel.workingDirectory}`]
            : []),
          "New visible messages in the room (oldest first):",
          ...lines,
          "",
          `It's your turn, ${target.name}. Use SendMessage if you have something useful to add; otherwise finish silently.`,
        ].join("\n");
        await this.enqueueWake(tx, {
          botId: target.id,
          channelId: round.channelId,
          deliveryId: delivery.id,
          origin: "group",
          type: "group.message",
          content,
          clientId: `group:${round.id}:${delivery.id}`,
          priority: PRIORITY.group,
          occurredAt: round.triggerMessage.createdAt,
          timeZone:
            round.triggerMessage.metadata &&
            !Array.isArray(round.triggerMessage.metadata) &&
            typeof round.triggerMessage.metadata === "object" &&
            typeof (round.triggerMessage.metadata as Record<string, unknown>).timeZone === "string"
              ? String((round.triggerMessage.metadata as Record<string, unknown>).timeZone)
              : this.defaultTimeZone,
        });
        await tx.channelDelivery.update({
          where: { id: delivery.id },
          data: { status: "queued" },
        });
        await tx.channelRound.update({
          where: { id: round.id },
          data: { status: "running", currentOrdinal: delivery.ordinal },
        });
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
    }
  }

  async completeDelivery(
    deliveryId: string,
    status: "completed" | "failed" | "skipped",
    error?: unknown
  ): Promise<void> {
    const delivery = await this.prisma.channelDelivery.findUnique({
      where: { id: deliveryId },
    });
    if (!delivery) return;
    if (["completed", "failed", "skipped"].includes(delivery.status)) {
      await this.advanceRound(delivery.roundId);
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.channelDelivery.update({
        where: { id: deliveryId },
        data: {
          status,
          completedAt: new Date(),
          error: error ? json(error) : undefined,
        },
      });
      await tx.event.create({
        data: {
          topic: "channel.delivery.completed",
          entityId: deliveryId,
          payload: json({ deliveryId, roundId: delivery.roundId, status }),
        },
      });
    });
    await this.advanceRound(delivery.roundId);
  }

  async recoverRounds(): Promise<void> {
    const rounds = await this.prisma.channelRound.findMany({
      where: { status: { in: ["queued", "running"] } },
      include: { deliveries: { include: { run: true } } },
      orderBy: { createdAt: "asc" },
    });
    for (const round of rounds) {
      const active = round.deliveries.find((delivery) =>
        ["queued", "processing"].includes(delivery.status)
      );
      if (active?.run && terminalRunStatuses.has(active.run.status)) {
        await this.completeDelivery(
          active.id,
          active.run.status === "completed" ? "completed" : "failed",
          active.run.error
        );
      } else if (!active) {
        await this.advanceRound(round.id);
      }
    }
  }

  async platformInstructions(botId: string): Promise<string> {
    const bot = await this.prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      include: {
        subagentIdentity: true,
        todos: { orderBy: { position: "asc" } },
      },
    });
    const todoContext = bot.todos.map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`);
    if (bot.subagentIdentity) {
      return [
        `You are ${bot.name}, a durable OpenBot background subagent.`,
        "Your plain final assistant message is delivered privately to your parent agent. Do not call SendMessage or SendToAgent.",
        "Use GetDynamicTools for graphical Computer control when needed. The cursor namespace exposes TodoWrite only; parent orchestration and administration tools are unavailable.",
        `The computer filesystem is shared. Your working folder is ${bot.defaultDirectory}; shared files live under /workspace/shared.`,
        todoContext.length > 0
          ? `Your durable task list:\n${todoContext.join("\n")}`
          : "Your durable task list is empty.",
        bot.instructions ? `Subagent instructions:\n${bot.instructions}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    const projectMemberships = await this.prisma.projectMember.findMany({
      where: { botId },
      include: { project: true },
      orderBy: { joinedAt: "asc" },
    });
    const memoryNamespaces = [
      `agent:${botId}`,
      "user",
      ...projectMemberships.map((membership) => `project:${membership.projectSlug}:agent:${botId}`),
    ];
    const [peers, groups, profileMemory, logMemory, noteMemory, skills, disconnected, routines] =
      await Promise.all([
        this.prisma.bot.findMany({
          where: { id: { not: botId }, status: "active", hiddenFromSidebar: false },
          select: { id: true, name: true },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.channel.findMany({
          where: {
            kind: "group",
            archivedAt: null,
            members: { some: { botId } },
          },
          select: { id: true, name: true, workingDirectory: true },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.memoryFact.findMany({
          where: { namespace: { in: memoryNamespaces }, tier: "profile" },
          orderBy: { updatedAt: "asc" },
          take: 60,
        }),
        this.prisma.memoryFact.findMany({
          where: { namespace: { in: memoryNamespaces }, tier: "log" },
          orderBy: { updatedAt: "desc" },
          take: 40,
        }),
        this.prisma.memoryFact.findMany({
          where: {
            namespace: { in: memoryNamespaces },
            tier: "note",
            updatedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000) },
          },
          orderBy: { updatedAt: "desc" },
          take: 12,
        }),
        this.prisma.savedSkill.findMany({
          where: { botId },
          orderBy: { updatedAt: "desc" },
          take: 20,
        }),
        this.prisma.botConnectorState.findMany({
          where: { botId, connected: false },
          select: { platform: true },
          orderBy: { platform: "asc" },
        }),
        this.prisma.routine.findMany({
          where: { botId, deletedAt: null },
          orderBy: { updatedAt: "desc" },
          take: 50,
        }),
      ]);
    const targets = [
      ...peers.map((peer) => `- Agent ${peer.name}: ${peer.id}`),
      ...groups.map(
        (group) =>
          `- Group ${group.name}: ${group.id}${group.workingDirectory ? ` (project folder: ${group.workingDirectory})` : ""}`
      ),
    ];
    const memory = [...profileMemory, ...logMemory, ...noteMemory];
    const memoryContext = memory.map((entry) => {
      const scope = entry.scope === "project" ? `project:${entry.projectSlug}` : entry.scope;
      return `- [${scope}/${entry.tier}] ${entry.fact}`;
    });
    let remainingSkillCharacters = 32_000;
    const skillContext = skills.map((skill) => {
      const body = skill.body.slice(0, Math.max(0, Math.min(8_000, remainingSkillCharacters)));
      remainingSkillCharacters -= body.length;
      return `### ${skill.name} (${skill.id})\n${skill.description}\n${body}${body.length < skill.body.length ? "\n[body truncated]" : ""}`;
    });
    const projectContext = projectMemberships.map(
      ({ project }) =>
        `- ${project.name} (${project.slug}): ${project.workingDirectory}${project.description ? ` — ${project.description}` : ""}`
    );
    const routineContext = routines.map(
      (routine) =>
        `- ${routine.name} (${routine.id}): ${routine.enabled ? "active" : "paused"}; ${routine.scheduleText}; next ${routine.nextRunAt?.toISOString() ?? "none"}`
    );
    return [
      `You are ${bot.name}, a durable OpenBot agent.`,
      bot.title ? `Your title is: ${bot.title}` : "",
      bot.description ? `Your description is:\n${bot.description}` : "",
      "SendMessage is your only user-visible voice. Plain assistant text is internal and never appears in OpenBot chat.",
      "Use GetDynamicTools with namespace openbot to discover SendToAgent and graphical Computer control. The cursor namespace exposes TodoWrite, Task/CheckSubagent/MessageSubagent/StopSubagent, CreateAgent/UpdateAgent, and CreateChannel/UpdateChannel. Invoke discovered tools with CallDynamicTool. SendToAgent and background Task are asynchronous; never wait or poll for their result in the same turn.",
      `Available Task subagent types are executor, videoReview, watchVideo, computerUse, and browserUse. The available subagent model slug is ${process.env.OPENBOT_PI_MODEL ?? "gpt-5.5"}; omit model unless the user explicitly asks for it.`,
      todoContext.length > 0
        ? `Durable task queue (reconcile it with TodoWrite on each wake):\n${todoContext.join("\n")}`
        : "The durable task queue is empty.",
      "In a room wake, speak only when you add something useful. Finishing without SendMessage is a valid silent turn.",
      "Use update_state for durable memory, scheduled routines, skills, profile, settings, connector disconnects, projects, and avatars. It is a write API. The current durable state relevant to you is supplied below on every turn.",
      `The computer filesystem is shared. Your default working folder is ${bot.defaultDirectory}. Shared cross-bot files belong under /workspace/shared; each group has its own project folder listed below. Folder paths organize work but are not security boundaries.`,
      `Safe peer-readable transcript mirrors live under /home/openbot/agent-data/agent-transcripts/<bot-id>/<bot-id>.jsonl. Read one only when a task-relevant reason requires it. They are redacted reference projections, not private model context or raw Pi session history.`,
      targets.length > 0
        ? `Available SendToAgent targets:\n${targets.join("\n")}`
        : "No peer or group targets are currently available.",
      memoryContext.length > 0
        ? `Durable memory (profile first, then recent log and unexpired notes):\n${memoryContext.join("\n")}`
        : "Durable memory is currently empty.",
      skillContext.length > 0
        ? `Saved skills. Apply one when its description matches the task:\n\n${skillContext.join("\n\n")}`
        : "No saved skills are currently installed for you.",
      projectContext.length > 0
        ? `Joined projects:\n${projectContext.join("\n")}`
        : "You have not joined any durable projects.",
      routineContext.length > 0
        ? `Scheduled routines:\n${routineContext.join("\n")}`
        : "You have no scheduled routines.",
      disconnected.length > 0
        ? `Disconnected connector platforms: ${disconnected.map(({ platform }) => platform).join(", ")}`
        : "No connector platform is marked disconnected.",
      bot.instructions ? `Bot-specific instructions:\n${bot.instructions}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async sendToAgent(context: ToolContext, input: SendToAgentInput): Promise<ToolResult> {
    let groupRoundId: string | null = null;
    const result = await this.prisma.$transaction(async (tx) => {
      const duplicate = await tx.channelMessage.findFirst({
        where: {
          clientId: `tool:${context.callId}`,
          senderBotId: context.botId,
        },
      });
      if (duplicate) {
        return {
          acknowledgement: {
            delivered: true,
            message_id: duplicate.id,
            duplicate: true,
          },
          interruptRunId: null,
        };
      }
      const source = await tx.bot.findUnique({ where: { id: context.botId } });
      if (!source || source.status !== "active") throw new Error("Source bot is not active");
      const group = await tx.channel.findFirst({
        where: {
          id: input.target_id,
          kind: "group",
          archivedAt: null,
          members: { some: { botId: context.botId } },
        },
        include: { members: true },
      });
      if (group) {
        const message = await tx.channelMessage.create({
          data: {
            channelId: group.id,
            sender: "agent",
            senderBotId: source.id,
            sourceRunId: context.runId,
            clientId: `tool:${context.callId}`,
            content: input.message,
            metadata: json({
              type: "text",
              images: input.images ?? [],
              timeZone: resolveTimeZone(context.timeZone ?? this.defaultTimeZone),
            }),
          },
        });
        await this.scheduleTranscriptProjection(
          tx,
          group.members.map((member) => member.botId)
        );
        await tx.channel.update({
          where: { id: group.id },
          data: { updatedAt: new Date() },
        });
        const round = await this.createGroupRound(tx, group.id, message.id, source.id);
        groupRoundId = round.id;
        return {
          acknowledgement: {
            delivered: true,
            target_id: group.id,
            target_type: "group",
            message_id: message.id,
            round_id: round.id,
          },
          interruptRunId: null,
        };
      }
      const target = await tx.bot.findUnique({
        where: { id: input.target_id },
      });
      if (
        !target ||
        !["active", "provisioning"].includes(target.status) ||
        target.id === source.id
      ) {
        throw new Error("Target agent was not found or is not eligible");
      }
      const directKey = `agents:${[source.id, target.id].sort().join(":")}`;
      const channel = await tx.channel.upsert({
        where: { directKey },
        create: {
          kind: "agent_dm",
          name: `${source.name} ↔ ${target.name}`,
          directKey,
          members: {
            create: [
              { botId: source.id, ordinal: 0 },
              { botId: target.id, ordinal: 1 },
            ],
          },
        },
        update: { archivedAt: null },
      });
      const message = await tx.channelMessage.create({
        data: {
          channelId: channel.id,
          sender: "agent",
          senderBotId: source.id,
          sourceRunId: context.runId,
          clientId: `tool:${context.callId}`,
          content: input.message,
          metadata: json({
            type: "text",
            images: input.images ?? [],
            timeZone: resolveTimeZone(context.timeZone ?? this.defaultTimeZone),
          }),
        },
      });
      await this.scheduleTranscriptProjection(tx, [source.id, target.id]);
      const prompt = [
        `[Direct message from ${source.name}]`,
        `${source.name}: ${input.message}`,
        "",
        "This is asynchronous. Use SendMessage if a reply would be useful; otherwise finish silently.",
      ].join("\n");
      await this.enqueueWake(tx, {
        botId: target.id,
        channelId: channel.id,
        origin: "agent",
        type: "agent.message",
        content: prompt,
        clientId: `agent:${message.id}:${target.id}`,
        priority: input.priority ? PRIORITY.urgentAgent : PRIORITY.agent,
        occurredAt: message.createdAt,
        timeZone: resolveTimeZone(context.timeZone ?? this.defaultTimeZone),
      });
      await tx.channel.update({
        where: { id: channel.id },
        data: { updatedAt: new Date() },
      });
      const lease = input.priority
        ? await tx.botRunLease.findUnique({
            where: { botId: target.id },
            include: { run: true },
          })
        : null;
      return {
        acknowledgement: {
          delivered: true,
          target_id: target.id,
          target_type: "agent",
          message_id: message.id,
          priority: Boolean(input.priority),
        },
        interruptRunId: lease && lease.run.origin !== "user" ? lease.runId : null,
      };
    });
    if (groupRoundId) await this.advanceRound(groupRoundId);
    return result;
  }

  async reactToMessage(
    context: ToolContext,
    input: ReactToMessageInput
  ): Promise<Record<string, unknown>> {
    const match = input.message_address.match(/^t(\d+)u$/);
    if (!match?.[1]) throw new Error("message_address must be a user address such as t42u");
    const sequence = BigInt(match[1]);
    const scope = `reaction:${context.botId}`;
    const requestHash = `${input.message_address}:${input.emoji}`;
    const receipt = await this.prisma.idempotencyRecord.findUnique({
      where: { scope_key: { scope, key: context.callId } },
    });
    if (receipt) {
      if (receipt.requestHash !== requestHash) {
        throw new Error("This reaction call id was already used with different arguments");
      }
      if (receipt.response) return receipt.response as Record<string, unknown>;
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.idempotencyRecord.create({
        data: {
          scope,
          key: context.callId,
          requestHash,
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000),
        },
      });
      const message = await tx.channelMessage.findFirst({
        where: {
          sequence,
          sender: "user",
          channel: { members: { some: { botId: context.botId } } },
        },
      });
      if (!message) throw new Error("The addressed user message is not visible to this bot");
      const metadata =
        message.metadata && !Array.isArray(message.metadata) && typeof message.metadata === "object"
          ? ({ ...message.metadata } as Record<string, unknown>)
          : {};
      const reactions = Array.isArray(metadata.reactions)
        ? metadata.reactions.filter(
            (reaction): reaction is { botId: string; emoji: string } =>
              Boolean(reaction) &&
              typeof reaction === "object" &&
              typeof (reaction as { botId?: unknown }).botId === "string" &&
              typeof (reaction as { emoji?: unknown }).emoji === "string"
          )
        : [];
      const current = reactions.find((reaction) => reaction.botId === context.botId);
      const next = reactions.filter((reaction) => reaction.botId !== context.botId);
      const removed = current?.emoji === input.emoji;
      if (!removed) next.push({ botId: context.botId, emoji: input.emoji });
      metadata.reactions = next;
      await tx.channelMessage.update({
        where: { id: message.id },
        data: { metadata: json(metadata) },
      });
      const result = {
        reacted: !removed,
        removed,
        message_address: input.message_address,
        emoji: input.emoji,
      };
      await tx.event.create({
        data: {
          topic: "channel.message.reaction",
          entityId: message.id,
          payload: json({ messageId: message.id, botId: context.botId, ...result }),
        },
      });
      await tx.idempotencyRecord.update({
        where: { scope_key: { scope, key: context.callId } },
        data: { status: "completed", response: json(result) },
      });
      await this.scheduleTranscriptProjection(tx, [context.botId]);
      return result;
    });
  }

  async sendVisible(context: ToolContext, input: AgentSendMessageInput): Promise<ToolResult> {
    const content = this.visibleContent(input);
    const result = await this.prisma.$transaction(async (tx) => {
      const channel = await tx.channel.findFirst({
        where: {
          id: context.channelId,
          archivedAt: null,
          members: { some: { botId: context.botId } },
        },
        include: { members: { orderBy: { ordinal: "asc" } } },
      });
      if (!channel) throw new Error("The active delivery channel is unavailable");
      const existing = await tx.channelMessage.findUnique({
        where: {
          channelId_clientId: {
            channelId: channel.id,
            clientId: `tool:${context.callId}`,
          },
        },
      });
      if (existing) {
        return {
          acknowledgement: {
            sent: true,
            message_id: existing.id,
            duplicate: true,
          },
          interruptRunId: null,
        };
      }
      const message = await tx.channelMessage.create({
        data: {
          channelId: channel.id,
          sender: "agent",
          senderBotId: context.botId,
          sourceRunId: context.runId,
          clientId: `tool:${context.callId}`,
          content,
          metadata: json({
            ...input,
            timeZone: resolveTimeZone(context.timeZone ?? this.defaultTimeZone),
          }),
        },
      });
      await this.scheduleTranscriptProjection(
        tx,
        channel.members.map((member) => member.botId)
      );
      await tx.channel.update({
        where: { id: channel.id },
        data: { updatedAt: new Date() },
      });
      if (channel.kind === "agent_dm") {
        const target = channel.members.find((member) => member.botId !== context.botId);
        const source = await tx.bot.findUniqueOrThrow({
          where: { id: context.botId },
        });
        if (target) {
          await this.enqueueWake(tx, {
            botId: target.botId,
            channelId: channel.id,
            origin: "agent",
            type: "agent.reply",
            content: [
              `[Direct reply from ${source.name}]`,
              `${source.name}: ${content}`,
              "",
              "Use SendMessage only if another reply is useful; otherwise finish silently.",
            ].join("\n"),
            clientId: `agent:${message.id}:${target.botId}`,
            priority: PRIORITY.agent,
            occurredAt: message.createdAt,
            timeZone: resolveTimeZone(context.timeZone ?? this.defaultTimeZone),
          });
        }
      }
      return {
        acknowledgement: {
          sent: true,
          channel_id: channel.id,
          channel_type: channel.kind,
          message_id: message.id,
        },
        interruptRunId: null,
      };
    });
    return result;
  }

  private visibleContent(input: AgentSendMessageInput): string {
    if (input.type === "text") {
      if (!input.content?.trim()) throw new Error("content is required when type is text");
      return input.content;
    }
    if (input.type === "attachment") {
      if (!input.url) throw new Error("url is required when type is attachment");
      return input.alt?.trim() || input.url;
    }
    if (input.type === "widget") {
      if (!input.widget) throw new Error("widget is required when type is widget");
      return input.widget.prompt;
    }
    if (input.type === "cursor-agent") {
      if (!input.bcId) throw new Error("bcId is required when type is cursor-agent");
      return `Cursor agent ${input.bcId}`;
    }
    if (!input.secret) throw new Error("secret is required when type is secret-request");
    return `Secret requested: ${input.secret.label}`;
  }
}

export { PRIORITY };
export { RoutineService, nextRoutineRun, normalizeRoutineSchedule } from "./routines";
export { formatTurnTimestamp, resolveTimeZone, timestampUserTurn } from "./timestamps";

const safeVisibleMetadata = (value: unknown): Record<string, unknown> => {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.type === "string" ? { type: record.type } : {}),
    ...(Array.isArray(record.images) ? { imageCount: record.images.length } : {}),
    ...(typeof record.reply_to === "string" ? { replyTo: record.reply_to } : {}),
    ...(record.widget && typeof record.widget === "object" ? { interactive: true } : {}),
  };
};

export async function buildSafeTranscript(
  prisma: PrismaClient,
  botId: string
): Promise<BotTranscriptView> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    include: { channelMemberships: true },
  });
  if (!bot) throw new Error(`Bot ${botId} was not found`);
  const channelIds = bot.channelMemberships.map((membership) => membership.channelId);
  const [messages, runs] = await Promise.all([
    prisma.channelMessage.findMany({
      where: { channelId: { in: channelIds } },
      include: { channel: true, senderBot: true },
      orderBy: { sequence: "asc" },
    }),
    prisma.run.findMany({
      where: { botId },
      include: { channel: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const events: TranscriptEventView[] = [
    ...messages.map(
      (message): TranscriptEventView => ({
        schemaVersion: 1,
        id: `message:${message.sequence}`,
        botId,
        at: message.createdAt.toISOString(),
        type: "visible_message",
        channel: {
          id: message.channel.id,
          kind: message.channel.kind,
          name: message.channel.name,
        },
        sender: {
          kind: message.sender,
          botId: message.senderBotId,
          name:
            message.sender === "user"
              ? "User"
              : message.sender === "system"
                ? "System"
                : (message.senderBot?.name ?? "Agent"),
        },
        content: message.content,
        metadata: safeVisibleMetadata(message.metadata),
      })
    ),
    ...runs.map((run): TranscriptEventView => {
      const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(run.status);
      const failed = ["failed", "cancelled", "interrupted"].includes(run.status);
      return {
        schemaVersion: 1,
        id: `run:${run.id}`,
        botId,
        at: (run.completedAt ?? run.startedAt ?? run.createdAt).toISOString(),
        type: failed ? "run_failed" : terminal ? "run_completed" : "run_started",
        channel: run.channel
          ? {
              id: run.channel.id,
              kind: run.channel.kind,
              name: run.channel.name,
            }
          : null,
        sender: null,
        content: null,
        metadata: { origin: run.origin, status: run.status },
      };
    }),
  ];
  events.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  return { botId, generatedAt: new Date().toISOString(), events };
}
