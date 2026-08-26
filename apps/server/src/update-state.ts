import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { ApiError, type UpdateStateInput } from "@openbot/contracts";
import { type Prisma, type PrismaClient } from "@openbot/db";
import type { RoutineService } from "@openbot/messaging";

const PROJECT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AVATAR_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

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

const factHash = (fact: string): string => createHash("sha256").update(fact).digest("hex");

const memoryNamespace = (botId: string, scope: "agent" | "user" | "project", project?: string) =>
  scope === "user"
    ? "user"
    : scope === "project"
      ? `project:${project}:agent:${botId}`
      : `agent:${botId}`;

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
    private readonly routines: RoutineService
  ) {}

  async execute(
    botId: string,
    callId: string,
    input: UpdateStateInput,
    runId: string | null = null
  ): Promise<Record<string, unknown>> {
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
      case "routine":
        if (!["create", "update", "pause", "resume", "delete"].includes(input.action)) {
          return stateError(input.target, input.action);
        }
        return this.routines.mutate(botId, callId, runId, {
          action: input.action as "create" | "update" | "pause" | "resume" | "delete",
          id: input.id,
          name: input.name,
          prompt: input.prompt,
          schedule: input.schedule,
          trigger: input.trigger,
          enabled: input.enabled,
        });
      case "skill":
        return this.skill(botId, input);
      case "profile":
        return this.profile(botId, input);
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
    const namespace = memoryNamespace(botId, scope, project);
    const hash = factHash(fact);

    if (input.action === "forget") {
      const removed = await this.prisma.memoryFact.deleteMany({
        where: { namespace, factHash: hash, fact },
      });
      return {
        target: "memory",
        action: "forget",
        forgotten: removed.count > 0,
        scope,
        project: project ?? null,
        fact,
      };
    }

    const tier = input.tier ?? "log";
    const saved = await this.prisma.memoryFact.upsert({
      where: { namespace_factHash: { namespace, factHash: hash } },
      create: {
        namespace,
        scope,
        tier,
        projectSlug: project,
        fact,
        factHash: hash,
        writtenByBotId: botId,
      },
      update: {
        tier,
        fact,
        writtenByBotId: botId,
      },
    });
    return {
      target: "memory",
      action: "write",
      id: saved.id,
      saved: true,
      scope,
      tier,
      project: project ?? null,
      fact,
    };
  }

  private async skill(botId: string, input: UpdateStateInput): Promise<Record<string, unknown>> {
    if (input.action === "delete") {
      const id = requiredText(input.id, "id", input.target, input.action);
      const removed = await this.prisma.savedSkill.deleteMany({ where: { id, botId } });
      if (removed.count === 0) {
        throw new ApiError(404, "skill_not_found", "That skill does not belong to this bot");
      }
      return { target: "skill", action: "delete", id, deleted: true };
    }
    if (input.action !== "write") return stateError(input.target, input.action);

    const name = requiredText(input.name, "name", input.target, input.action);
    const description = requiredText(input.description, "description", input.target, input.action);
    const body = requiredText(input.body, "body", input.target, input.action);
    if (!/^use this when\b/i.test(description)) {
      throw new ApiError(
        400,
        "skill_description_invalid",
        'Skill description must start with "use this when" so the agent can select it reliably'
      );
    }

    const saved = input.id
      ? await this.rewriteSkill(botId, input.id, { name, description, body })
      : await this.prisma.savedSkill.upsert({
          where: { botId_name: { botId, name } },
          create: { botId, name, description, body },
          update: { description, body },
        });
    return {
      target: "skill",
      action: "write",
      id: saved.id,
      name: saved.name,
      saved: true,
    };
  }

  private async rewriteSkill(
    botId: string,
    id: string,
    data: { name: string; description: string; body: string }
  ) {
    const skill = await this.prisma.savedSkill.findFirst({ where: { id, botId } });
    if (!skill)
      throw new ApiError(404, "skill_not_found", "That skill does not belong to this bot");
    return this.prisma.savedSkill.update({ where: { id }, data });
  }

  private async profile(botId: string, input: UpdateStateInput): Promise<Record<string, unknown>> {
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
    const bot = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.bot.update({
        where: { id: botId },
        data: { name, description },
        select: { id: true, name: true, description: true },
      });
      if (name) {
        await tx.channel.updateMany({ where: { directKey: `bot:${botId}` }, data: { name } });
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
    const settings = await this.prisma.bot.update({
      where: { id: botId },
      data: {
        hiddenFromSidebar: input.hidden_from_sidebar,
        notificationsEnabled: input.notify_on_updates,
      },
      select: { hiddenFromSidebar: true, notificationsEnabled: true },
    });
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
    return { target: "channel", action: "disconnect", platform, disconnected: true };
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
      return { target: "project", action: "leave", project: slug, left: removed.count > 0 };
    }
    if (input.action === "join") {
      const project = await this.prisma.project.findUnique({ where: { slug } });
      if (!project) throw new ApiError(404, "project_not_found", `Project ${slug} does not exist`);
      await this.prisma.projectMember.upsert({
        where: { projectSlug_botId: { projectSlug: slug, botId } },
        create: { projectSlug: slug, botId },
        update: {},
      });
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
      await this.prisma.bot.update({ where: { id: botId }, data: { avatarPath: null } });
      return { target: "avatar", action: "clear", cleared: true };
    }
    if (input.action !== "set") return stateError(input.target, input.action);
    const supplied = requiredText(input.path, "path", input.target, input.action);
    if (!isAbsolute(supplied)) {
      throw new ApiError(400, "avatar_path_invalid", "Avatar path must be absolute");
    }
    const canonical = await realpath(supplied).catch(() => null);
    if (!canonical || !this.isInsideWorkspace(canonical)) {
      throw new ApiError(
        400,
        "avatar_path_invalid",
        `Avatar must be an existing file under ${this.workspaceRoot}`
      );
    }
    if (!AVATAR_EXTENSIONS.has(extname(canonical).toLowerCase())) {
      throw new ApiError(400, "avatar_type_invalid", "Avatar must be png, jpg, webp, gif, or svg");
    }
    const info = await stat(canonical);
    if (!info.isFile() || info.size <= 0 || info.size >= MAX_AVATAR_BYTES) {
      throw new ApiError(400, "avatar_size_invalid", "Avatar must be a non-empty file under 5 MB");
    }
    await this.prisma.bot.update({ where: { id: botId }, data: { avatarPath: canonical } });
    return {
      target: "avatar",
      action: "set",
      path: canonical,
      bytes: info.size,
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
    const directory = resolve(this.workspaceRoot, "projects", slug);
    if (!this.isInsideWorkspace(directory)) {
      throw new ApiError(400, "project_path_invalid", "Project path escaped the workspace root");
    }
    return directory;
  }

  private isInsideWorkspace(path: string): boolean {
    const normalizedRoot = resolve(this.workspaceRoot);
    const difference = relative(normalizedRoot, resolve(path));
    return difference !== "" && difference !== ".." && !difference.startsWith(`..${sep}`);
  }
}
