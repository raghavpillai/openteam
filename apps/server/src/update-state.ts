import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { ApiError, type UpdateStateInput } from "@openteam/contracts";
import type { Prisma, PrismaClient } from "@openteam/db";
import {
  appendAgentTimelineEvent,
  type AgentDataStore,
  type RoutineService,
  type TimelineEventWakeHost,
} from "@openteam/messaging";

const PROJECT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const requiredText = (
  value: string | undefined,
  field: string,
  target: string,
  action: string
): string => {
  const text = value?.trim();
  if (!text) {
    throw new ApiError(400, "state_field_required", `${field} is required for ${target} ${action}`);
  }
  return text;
};

const stateError = (target: string, action: string): never => {
  throw new ApiError(
    400,
    "state_action_invalid",
    `update_state does not support target=${target} with action=${action}`
  );
};

const eventPayload = (value: Record<string, unknown>): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export class DurableStateService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly workspaceRoot: string,
    private readonly provisionProject: (input: {
      path: string;
      name: string;
      description: string;
    }) => Promise<void>,
    private readonly routines: RoutineService,
    private readonly agentData: AgentDataStore,
    private readonly timelineHost: TimelineEventWakeHost
  ) {}

  async execute(
    botId: string,
    callId: string,
    input: UpdateStateInput,
    runId: string | null = null
  ): Promise<Record<string, unknown>> {
    await this.agentData.reconcileBot(botId);
    const bot = await this.prisma.bot.findUnique({ where: { id: botId } });
    if (!bot || bot.status !== "active") {
      throw new ApiError(404, "bot_not_found", "Active bot not found");
    }
    const scope = `update_state:${botId}`;
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { scope_key: { scope, key: callId } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ApiError(
          409,
          "state_call_conflict",
          "This update_state call id was already used with different arguments"
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
      const result = await this.mutate(botId, callId, runId, input);
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
    input: UpdateStateInput
  ): Promise<Record<string, unknown>> {
    switch (input.target) {
      case "memory":
        return this.memory(botId, input);
      case "routine": {
        if (!["create", "update", "pause", "resume", "delete"].includes(input.action)) {
          return stateError(input.target, input.action);
        }
        const routine = await this.routines.mutate(botId, callId, runId, {
          action: input.action as "create" | "update" | "pause" | "resume" | "delete",
          id: input.id,
          name: input.name,
          prompt: input.prompt,
          schedule: input.schedule,
          trigger: input.trigger,
          enabled: input.enabled,
        });
        return routine;
      }
      case "skill":
        return this.skill(botId, input);
      case "profile":
        return this.profile(botId, callId, input);
      case "settings":
        return this.settings(botId, input);
      case "channel":
        return this.channel(botId, input);
      case "project":
        return this.project(botId, input);
      case "avatar":
        return this.avatar(botId, input);
    }
  }

  private async memory(botId: string, input: UpdateStateInput): Promise<Record<string, unknown>> {
    if (input.action !== "write" && input.action !== "forget") {
      return stateError(input.target, input.action);
    }
    const fact = requiredText(input.fact, "fact", input.target, input.action);
    const scope = input.scope ?? "agent";
    const project =
      scope === "project"
        ? this.requireProjectSlug(input.project, input.target, input.action)
        : undefined;
    if (project) await this.requireProjectMembership(botId, project);
    if (input.action === "forget") {
      const removed = await this.agentData.forgetMemory(botId, {
        scope,
        projectSlug: project,
        fact,
      });
      return {
        target: "memory",
        action: "forget",
        forgotten: removed.forgotten,
        scope,
        project: project ?? null,
        fact,
      };
    }

    const tier = input.tier ?? "log";
    const saved = await this.agentData.writeMemory(botId, {
      scope,
      projectSlug: project,
      tier,
      fact,
    });
    return {
      target: "memory",
      action: "write",
      id: saved.logicalId,
      saved: saved.saved,
      scope,
      tier,
      project: project ?? null,
      fact,
    };
  }

  private async skill(botId: string, input: UpdateStateInput): Promise<Record<string, unknown>> {
    if (input.action === "delete") {
      const id = requiredText(input.id, "id", input.target, input.action);
      const removed = await this.agentData.deleteSkill(botId, id);
      if (!removed) {
        throw new ApiError(404, "skill_not_found", "That skill does not belong to this bot");
      }
      return { target: "skill", action: "delete", id, deleted: true };
    }
    if (input.action !== "write") return stateError(input.target, input.action);

    const name = requiredText(input.name, "name", input.target, input.action);
    const description = requiredText(input.description, "description", input.target, input.action);
    const body = requiredText(input.body, "body", input.target, input.action);
    const saved = await this.agentData.writeSkill(botId, {
      id: input.id,
      name,
      description,
      body,
    });
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
    input: UpdateStateInput
  ): Promise<Record<string, unknown>> {
    if (input.action !== "set") return stateError(input.target, input.action);
    if (input.name === undefined && input.description === undefined) {
      throw new ApiError(
        400,
        "state_field_required",
        "profile set requires name and/or description"
      );
    }
    const name =
      input.name === undefined ? undefined : requiredText(input.name, "name", "profile", "set");
    const description = input.description?.trim();
    const bot = await this.agentData.mutateBotFiles(botId, ["profile"], async (tx) => {
      const previous = await tx.bot.findUniqueOrThrow({ where: { id: botId } });
      const updated = await tx.bot.update({
        where: { id: botId },
        data: { name, description },
        select: { id: true, name: true, description: true },
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
      updated: true,
    };
  }

  private async settings(botId: string, input: UpdateStateInput): Promise<Record<string, unknown>> {
    if (input.action !== "set") return stateError(input.target, input.action);
    if (input.hidden_from_sidebar === undefined && input.notify_on_updates === undefined) {
      throw new ApiError(
        400,
        "state_field_required",
        "settings set requires hidden_from_sidebar and/or notify_on_updates"
      );
    }
    const settings = await this.agentData.mutateBotFiles(botId, ["settings"], (tx) =>
      tx.bot.update({
        where: { id: botId },
        data: {
          hiddenFromSidebar: input.hidden_from_sidebar,
          notificationsEnabled: input.notify_on_updates,
        },
        select: {
          hiddenFromSidebar: true,
          notificationsEnabled: true,
        },
      })
    );
    return {
      target: "settings",
      action: "set",
      hidden_from_sidebar: settings.hiddenFromSidebar,
      notify_on_updates: settings.notificationsEnabled,
      updated: true,
    };
  }

  private async channel(botId: string, input: UpdateStateInput): Promise<Record<string, unknown>> {
    if (input.action !== "disconnect") return stateError(input.target, input.action);
    const platform = requiredText(
      input.platform,
      "platform",
      input.target,
      input.action
    ).toLowerCase();
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

  private async project(botId: string, input: UpdateStateInput): Promise<Record<string, unknown>> {
    if (!(["create", "join", "leave"] as const).includes(input.action as never)) {
      return stateError(input.target, input.action);
    }
    const slug = this.requireProjectSlug(input.project, input.target, input.action);
    if (input.action === "leave") {
      const removed = await this.prisma.projectMember.deleteMany({
        where: { projectSlug: slug, botId },
      });
      await this.agentData.writeBotFiles(botId, ["projects"]);
      return {
        target: "project",
        action: "leave",
        project: slug,
        left: removed.count > 0,
      };
    }
    if (input.action === "join") {
      const project = await this.prisma.project.findUnique({ where: { slug } });
      if (!project) throw new ApiError(404, "project_not_found", `Project ${slug} does not exist`);
      await this.prisma.projectMember.upsert({
        where: { projectSlug_botId: { projectSlug: slug, botId } },
        create: { projectSlug: slug, botId },
        update: {},
      });
      await this.agentData.writeProjectFile(slug);
      await this.agentData.writeBotFiles(botId, ["projects"]);
      return {
        target: "project",
        action: "join",
        project: slug,
        name: project.name,
        working_directory: project.workingDirectory,
        joined: true,
      };
    }

    const name = requiredText(input.name, "name", input.target, input.action);
    const description = input.description?.trim() ?? "";
    const workingDirectory = this.projectDirectory(slug);
    await this.provisionProject({ path: workingDirectory, name, description });
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.project.findUnique({ where: { slug } });
      const saved =
        existing ??
        (await tx.project.create({
          data: {
            slug,
            name,
            description,
            workingDirectory,
            createdByBotId: botId,
          },
        }));
      await tx.projectMember.upsert({
        where: { projectSlug_botId: { projectSlug: slug, botId } },
        create: { projectSlug: slug, botId },
        update: {},
      });
      return { project: saved, created: existing === null };
    });
    await this.agentData.writeProjectFile(slug);
    await this.agentData.writeBotFiles(botId, ["projects"]);
    return {
      target: "project",
      action: "create",
      project: slug,
      name: result.project.name,
      working_directory: result.project.workingDirectory,
      joined: true,
      created: result.created,
    };
  }

  private async avatar(botId: string, input: UpdateStateInput): Promise<Record<string, unknown>> {
    if (input.action === "clear") {
      await this.agentData.setAvatarFromPath(botId, null);
      return { target: "avatar", action: "clear", cleared: true };
    }
    if (input.action !== "set") return stateError(input.target, input.action);
    const supplied = requiredText(input.path, "path", input.target, input.action);
    let saved: { path: string | null; resolvedPath: string | null; bytes: number };
    try {
      saved = await this.agentData.setAvatarFromPath(botId, supplied);
    } catch (error) {
      throw new ApiError(
        400,
        "avatar_path_invalid",
        error instanceof Error ? error.message : "Avatar source is invalid"
      );
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

  private requireProjectSlug(value: string | undefined, target: string, action: string): string {
    const slug = requiredText(value, "project", target, action).toLowerCase();
    if (!PROJECT_SLUG.test(slug) || slug.length > 80) {
      throw new ApiError(
        400,
        "project_slug_invalid",
        "Project slug must contain lowercase letters, numbers, and single hyphens"
      );
    }
    return slug;
  }

  private async requireProjectMembership(botId: string, projectSlug: string): Promise<void> {
    const membership = await this.prisma.projectMember.findUnique({
      where: { projectSlug_botId: { projectSlug, botId } },
    });
    if (!membership) {
      throw new ApiError(409, "project_not_joined", `Join project ${projectSlug} before using it`);
    }
  }

  private projectDirectory(slug: string): string {
    void slug;
    return resolve(this.workspaceRoot);
  }

  private isInsideWorkspace(path: string): boolean {
    const normalizedRoot = resolve(this.workspaceRoot);
    const difference = relative(normalizedRoot, resolve(path));
    return difference !== "" && difference !== ".." && !difference.startsWith(`..${sep}`);
  }
}
