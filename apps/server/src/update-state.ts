import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
  ApiError,
  DisconnectChannelToolInput,
  resolveBotAvatarColorName,
  STATE_TOOL_TARGETS,
  type StateToolName,
  UpdateAvatarToolInput,
  UpdateMemoryToolInput,
  UpdateProfileToolInput,
  UpdateRoutineToolInput,
  UpdateSkillToolInput,
  type UpdateStateInput,
} from "@openteam/contracts";
import type { Prisma, PrismaClient } from "@openteam/db";
import {
  appendAgentTimelineEvent,
  type AgentDataStore,
  type RoutineService,
  type TimelineEventWakeHost,
} from "@openteam/messaging";

const requiredText = (
  value: string | undefined,
  field: string,
  tool: StateToolName,
  action: string
): string => {
  const text = value?.trim();
  if (!text) {
    throw new ApiError(400, "state_field_required", `${tool} ${action} requires ${field}`);
  }
  return text;
};

/** The reference's state refusal: a normal result the model reads as "Not saved: <reason>". */
const refused = (target: string, action: string, reason: string) => ({ target, action, refused: reason });

const stateError = (tool: StateToolName, action: string): never => {
  throw new ApiError(400, "state_action_invalid", `${tool} does not support action=${action}`);
};

const PROFILE_FIELDS = ["name", "description", "title", "avatar_shape", "avatar_color"] as const;
const SHARED_MEMORY_SHARED_CONVERSATION_REFUSAL =
  "shared_profile and shared_journal are the owner's memory across their assistants and are not written from a shared conversation.";
const SETTINGS_FIELDS = ["hidden_from_sidebar", "notify_on_updates", "drafting_disabled"] as const;
const DRAFTING_OFF_NEEDS_THE_USER =
  'only the user can turn drafts off. Nothing was changed. Tell them to click "Disable drafts for this Bot" on a draft card.';

const stateToolArguments = {
  UpdateMemory: UpdateMemoryToolInput,
  UpdateRoutine: UpdateRoutineToolInput,
  UpdateSkill: UpdateSkillToolInput,
  UpdateProfile: UpdateProfileToolInput,
  UpdateAvatar: UpdateAvatarToolInput,
  DisconnectChannel: DisconnectChannelToolInput,
} satisfies Record<StateToolName, Schema.Schema.AnyNoContext>;

const eventPayload = (value: Record<string, unknown>): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export class DurableStateService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly routines: RoutineService,
    private readonly agentData: AgentDataStore,
    private readonly timelineHost: TimelineEventWakeHost
  ) {}

  /** Run one state tool call as an update of its fixed target. */
  async executeTool(
    botId: string,
    callId: string,
    tool: StateToolName,
    args: unknown,
    runId: string | null = null
  ): Promise<Record<string, unknown>> {
    const schema: Schema.Schema.AnyNoContext = stateToolArguments[tool];
    const input: Partial<UpdateStateInput> = Schema.decodeUnknownSync(schema)(args);
    const run = (state: UpdateStateInput, key = callId) => this.execute(botId, key, state, runId, tool);
    if (tool === "DisconnectChannel") return run({ ...input, target: "channel", action: "disconnect" });
    if (tool !== "UpdateProfile") return run({ ...input, target: STATE_TOOL_TARGETS[tool], action: input.action! });
    // Profile and settings are separate state. When both change, the settings half is
    // its own idempotent update under a derived call id.
    const passed = (fields: readonly (keyof UpdateStateInput)[]) =>
      Object.fromEntries(fields.filter((field) => input[field] !== undefined).map((field) => [field, input[field]]));
    const profile: UpdateStateInput = { ...passed(PROFILE_FIELDS), target: "profile", action: "set" };
    const settings: UpdateStateInput = { ...passed(SETTINGS_FIELDS), target: "settings", action: "set" };
    const changesSettings = SETTINGS_FIELDS.some((field) => input[field] !== undefined);
    if (!changesSettings || PROFILE_FIELDS.every((field) => input[field] === undefined))
      return run(changesSettings ? settings : profile);
    const saved = await run(profile);
    if (typeof saved.refused === "string") return saved;
    try {
      return { ...saved, settings: await run(settings, `${callId}:settings`) };
    } catch (error) {
      // The profile change stands; report the settings that did not save.
      return { ...saved, settings_error: error instanceof Error ? error.message : String(error) };
    }
  }

  async execute(
    botId: string,
    callId: string,
    input: UpdateStateInput,
    runId: string | null,
    tool: StateToolName
  ): Promise<Record<string, unknown>> {
    await this.agentData.reconcileBot(botId);
    const bot = await this.prisma.bot.findUnique({ where: { id: botId } });
    if (!bot || bot.status !== "active") {
      throw new ApiError(404, "bot_not_found", "Active bot not found");
    }
    const scope = `state:${botId}`;
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { scope_key: { scope, key: callId } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ApiError(
          409,
          "state_call_conflict",
          `This ${tool} call id was already used with different arguments`
        );
      }
      if (existing.status === "completed" && existing.response) {
        return existing.response as Record<string, unknown>;
      }
    } else {
      await this.prisma.idempotencyRecord.create({
        data: {
          scope,
          key: callId,
          requestHash,
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000),
        },
      });
    }

    try {
      const result = await this.mutate(botId, callId, runId, input, tool);
      await this.agentData.projectBot(botId);
      await this.prisma.$transaction(async (tx) => {
        await tx.event.create({
          data: {
            topic: "bot.state.updated",
            entityId: botId,
            payload: eventPayload({
              botId,
              callId,
              target: input.target,
              action: input.action,
              result,
            }),
          },
        });
        await tx.idempotencyRecord.update({
          where: { scope_key: { scope, key: callId } },
          data: { status: "completed", response: eventPayload(result) },
        });
      });
      return result;
    } catch (error) {
      await this.prisma.idempotencyRecord.deleteMany({
        where: { scope, key: callId, status: "processing", requestHash },
      });
      throw error;
    }
  }

  private async mutate(
    botId: string,
    callId: string,
    runId: string | null,
    input: UpdateStateInput,
    tool: StateToolName
  ): Promise<Record<string, unknown>> {
    switch (input.target) {
      case "memory":
        return this.memory(botId, input, runId, tool);
      case "routine": {
        if (!["create", "update", "pause", "resume", "delete"].includes(input.action)) {
          return stateError(tool, input.action);
        }
        const run = runId ? await this.prisma.run.findFirst({ where: { id: runId, botId }, select: { channelId: true } }) : null;
        const group = run?.channelId ? await this.prisma.channel.findFirst({ where: {
          id: run.channelId, kind: "group", archivedAt: null, members: { some: { botId } },
        }, select: { id: true, name: true } }) : null;
        const owner = group ? { kind: "group" as const, id: group.id } : { kind: "bot" as const, id: botId };
        const routine = await this.routines.mutateOwner(owner, callId, runId, {
          action: input.action as "create" | "update" | "pause" | "resume" | "delete",
          id: input.id,
          name: input.name,
          prompt: input.prompt,
          schedule: input.schedule,
          trigger: input.trigger,
          enabled: input.enabled,
        });
        return { ...routine, owner: { ...owner, ...(group ? { name: group.name } : {}) } };
      }
      case "skill":
        return this.skill(botId, input, tool);
      case "profile":
        return this.profile(botId, callId, input, tool);
      case "settings":
        return this.settings(botId, input, tool);
      case "channel":
        return this.channel(botId, input, tool);
      case "avatar":
        return this.avatar(botId, input, tool);
    }
  }

  private async memory(
    botId: string,
    input: UpdateStateInput,
    runId: string | null,
    tool: StateToolName
  ): Promise<Record<string, unknown>> {
    if (input.action !== "write" && input.action !== "forget") {
      return stateError(tool, input.action);
    }
    const fact = requiredText(input.fact, "fact", tool, input.action);
    const type = input.type;
    if (!type) throw new ApiError(400, "state_field_required", `${tool} ${input.action} requires type`);
    const scope = type === "shared_profile" || type === "shared_journal" ? "user" : "agent";
    const run = runId ? await this.prisma.run.findFirst({ where: { id: runId, botId }, select: { channelId: true } }) : null;
    if (scope === "user" && (await this.agentData.isSharedConversation(botId, run?.channelId))) {
      return { target: "memory", action: input.action, type, refused: SHARED_MEMORY_SHARED_CONVERSATION_REFUSAL };
    }
    if (input.action === "forget") {
      const removed = await this.agentData.forgetMemory(botId, { scope, fact });
      return { target: "memory", action: "forget", type, forgotten: removed.forgotten, fact: removed.content };
    }
    const saved = await this.agentData.writeMemory(
      botId,
      { scope, tier: type === "profile" || type === "shared_profile" ? "profile" : "log", fact },
      { source: "tool", ...(runId ? { turnId: runId } : {}) }
    );
    return { target: "memory", action: "write", type, id: saved.logicalId, saved: saved.saved, fact: saved.content };
  }

  private async skill(
    botId: string,
    input: UpdateStateInput,
    tool: StateToolName
  ): Promise<Record<string, unknown>> {
    if (input.action === "delete") {
      const id = requiredText(input.id, "id", tool, input.action);
      if (!(await this.agentData.deleteSkill(botId, id)))
        return refused("skill", "delete", `no skill with id "${id}" exists, or it is a managed or plugin skill, which cannot be deleted.`);
      return { target: "skill", action: "delete", id, deleted: true };
    }
    if (input.action !== "write") return stateError(tool, input.action);

    const missing = `no skill with id "${input.id}" exists, or the new fields were invalid. Managed and plugin skills cannot be edited.`;
    const [name, description, body] = [input.name, input.description, input.body].map((value) => value?.trim());
    if (!name || !description || !body)
      return refused("skill", "write", input.id === undefined
        ? "the skill could not be saved. A name, a one-line description, and a non-empty body are all required."
        : missing);
    const saved = await this.agentData.writeSkill(botId, { id: input.id, name, description, body }).catch((error: unknown) => {
      if (error instanceof Error && error.message === "Skill not found") return null;
      throw error;
    });
    if (!saved) return refused("skill", "write", missing);
    return {
      target: "skill",
      action: "write",
      id: saved.id,
      name: saved.name,
      saved: true,
    };
  }

  private async profile(
    botId: string,
    callId: string,
    input: UpdateStateInput,
    tool: StateToolName
  ): Promise<Record<string, unknown>> {
    if (input.action !== "set") return stateError(tool, input.action);
    if (PROFILE_FIELDS.every((field) => input[field] === undefined))
      return refused("profile", "set", "nothing to change. Pass at least one of name, description, title, avatar_shape, or avatar_color.");
    if (input.name !== undefined && !input.name.trim()) return refused("profile", "set", "a blank name is not allowed.");
    const name = input.name?.trim();
    const description = input.description?.trim();
    const bot = await this.agentData.mutateBotFiles(botId, ["profile"], async (tx) => {
      const previous = await tx.bot.findUniqueOrThrow({ where: { id: botId } });
      const updated = await tx.bot.update({
        where: { id: botId },
        data: { name, description, title: input.title, icon: input.avatar_shape, color: input.avatar_color === undefined ? undefined : resolveBotAvatarColorName(input.avatar_color) },
        select: { id: true, name: true, description: true, title: true, icon: true, color: true },
      });
      if (name) {
        await tx.channel.updateMany({
          where: { directKey: `bot:${botId}` },
          data: { name },
        });
      }
      if (previous.name && name && previous.name !== name) {
        await appendAgentTimelineEvent(tx, this.timelineHost, {
          botId,
          clientId: `profile-state:${callId}`,
          event: { type: "name-changed", from: previous.name, to: name },
        });
      }
      return updated;
    });
    return {
      target: "profile",
      action: "set",
      name: bot.name,
      description: bot.description,
      title: bot.title,
      avatar_shape: bot.icon,
      avatar_color: bot.color,
      updated: true,
    };
  }

  private async settings(
    botId: string,
    input: UpdateStateInput,
    tool: StateToolName
  ): Promise<Record<string, unknown>> {
    if (input.action !== "set") return stateError(tool, input.action);
    // Drafts are turned off from a draft card by the user; the bot can only turn them back on.
    if (input.drafting_disabled === true) return refused("settings", "set", DRAFTING_OFF_NEEDS_THE_USER);
    if (SETTINGS_FIELDS.every((field) => input[field] === undefined))
      return refused("settings", "set", "nothing to change. Pass at least one setting field.");
    const settings = await this.agentData.mutateBotFiles(botId, ["settings"], (tx) =>
      tx.bot.update({
        where: { id: botId },
        data: {
          hiddenFromSidebar: input.hidden_from_sidebar,
          notificationsEnabled: input.notify_on_updates,
          draftingDisabled: input.drafting_disabled,
        },
        select: {
          hiddenFromSidebar: true,
          notificationsEnabled: true,
          draftingDisabled: true,
        },
      })
    );
    return {
      target: "settings",
      action: "set",
      hidden_from_sidebar: settings.hiddenFromSidebar,
      notify_on_updates: settings.notificationsEnabled,
      drafting_disabled: settings.draftingDisabled,
      updated: true,
    };
  }

  private async channel(
    botId: string,
    input: UpdateStateInput,
    tool: StateToolName
  ): Promise<Record<string, unknown>> {
    if (input.action !== "disconnect") return stateError(tool, input.action);
    const platform = requiredText(input.platform, "platform", tool, input.action).toLowerCase();
    const state = await this.prisma.botConnectorState.findUnique({ where: { botId_platform: { botId, platform } } });
    if (!state?.connected) return { ...refused("channel", "disconnect", `${platform} is not connected.`), platform };
    const disconnectedAt = new Date();
    await this.prisma.botConnectorState.upsert({
      where: { botId_platform: { botId, platform } },
      create: { botId, platform, connected: false, disconnectedAt },
      update: { connected: false, disconnectedAt },
    });
    await this.agentData.writeConnectorFile(botId, platform);
    return {
      target: "channel",
      action: "disconnect",
      platform,
      disconnected: true,
    };
  }

  private async avatar(
    botId: string,
    input: UpdateStateInput,
    tool: StateToolName
  ): Promise<Record<string, unknown>> {
    if (input.action === "clear") {
      const bot = await this.prisma.bot.findUnique({ where: { id: botId }, select: { avatarPath: true } });
      if (!bot?.avatarPath) return refused("avatar", "clear", "you already have the default picture.");
      await this.agentData.setAvatarFromPath(botId, null);
      return { target: "avatar", action: "clear", cleared: true };
    }
    if (input.action !== "set") return stateError(tool, input.action);
    const supplied = requiredText(input.path, "path", tool, input.action);
    let saved: { path: string | null; resolvedPath: string | null; bytes: number };
    try {
      saved = await this.agentData.setAvatarFromPath(botId, supplied);
    } catch (error) {
      return refused("avatar", "set", error instanceof Error ? error.message : "the picture could not be installed.");
    }
    return {
      target: "avatar",
      action: "set",
      path: saved.path,
      resolved_path: saved.resolvedPath,
      bytes: saved.bytes,
      updated: true,
    };
  }
}
