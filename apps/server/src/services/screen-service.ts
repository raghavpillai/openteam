import { readFile, realpath } from "node:fs/promises";
import { extname, relative, sep } from "node:path";
import { ApiError, type ScreenActionInput, type ScreenStatusView } from "@openbot/contracts";
import type { PrismaClient } from "@openbot/db";
import { Effect } from "effect";

interface ComputerScreenStatus {
  botId: string;
  state: "starting" | "ready" | "failed";
  width: number;
  height: number;
  display: number;
  viewerPort: number;
  humanTakeover: boolean;
  agentInputPaused: boolean;
  apps: Array<"chromium" | "thunar" | "terminal">;
  browserProfileScope: "bot";
  browserSessionScope: "computer";
  browserSessionMechanism: "cookie-broker";
  error: string | null;
}

type ComputerFetch = (path: string, init: RequestInit) => Promise<Response>;

export class ScreenService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly workspaceRoot: string,
    private readonly screenViewerHost: string,
    private readonly computerFetch: ComputerFetch
  ) {}

  status = (botId: string) =>
    Effect.tryPromise({
      try: async () => {
        const bot = await this.prisma.bot.findUnique({ where: { id: botId } });
        if (!bot || bot.status === "archived") {
          throw new ApiError(404, "bot_not_found", "Bot not found");
        }
        if (bot.status !== "active") {
          return this.pendingView(bot.id, bot.status === "failed" ? "failed" : "starting");
        }
        const response = await this.computerFetch(
          `/v1/screens/${bot.id}?cwd=${encodeURIComponent(bot.defaultDirectory)}`,
          { method: "GET" }
        );
        if (!response.ok) throw new ApiError(503, "screen_unavailable", await response.text());
        return this.toView(bot.id, (await response.json()) as ComputerScreenStatus);
      },
      catch: ScreenService.toError,
    });

  frame = (botId: string) =>
    Effect.tryPromise({
      try: async () => {
        const bot = await this.requireActiveBot(botId);
        const response = await this.computerFetch(
          `/v1/screens/${bot.id}/frame?cwd=${encodeURIComponent(bot.defaultDirectory)}`,
          { method: "GET", signal: AbortSignal.timeout(15_000) }
        );
        if (!response.ok) throw new ApiError(503, "screen_unavailable", await response.text());
        return {
          bytes: await response.arrayBuffer(),
          contentType: response.headers.get("content-type") ?? "image/png",
        };
      },
      catch: ScreenService.toError,
    });

  avatar = (botId: string) =>
    Effect.tryPromise({
      try: async () => {
        const bot = await this.prisma.bot.findUnique({
          where: { id: botId },
          select: { avatarPath: true },
        });
        if (!bot?.avatarPath) throw new ApiError(404, "avatar_not_found", "Bot has no avatar");
        const path = await realpath(bot.avatarPath).catch(() => null);
        const difference = path ? relative(this.workspaceRoot, path) : "..";
        if (
          !path ||
          difference === "" ||
          difference === ".." ||
          difference.startsWith(`..${sep}`)
        ) {
          throw new ApiError(404, "avatar_not_found", "Bot avatar is unavailable");
        }
        const contentType =
          {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
            ".svg": "image/svg+xml",
          }[extname(path).toLowerCase()] ?? "application/octet-stream";
        return { bytes: await readFile(path), contentType };
      },
      catch: ScreenService.toError,
    });

  action = (botId: string, input: ScreenActionInput) =>
    Effect.tryPromise({
      try: async () => {
        const bot = await this.requireActiveBot(botId);
        const response = await this.computerFetch(`/v1/screens/${bot.id}/actions`, {
          method: "POST",
          body: JSON.stringify({ cwd: bot.defaultDirectory, input }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          throw new ApiError(409, "screen_action_rejected", await response.text());
        }
        return this.toView(bot.id, (await response.json()) as ComputerScreenStatus);
      },
      catch: ScreenService.toError,
    });

  takeover = (botId: string, active: boolean) => this.updateControl(botId, "takeover", { active });

  pause = (botId: string, paused: boolean) => this.updateControl(botId, "pause", { paused });

  private async requireActiveBot(botId: string) {
    const bot = await this.prisma.bot.findUnique({ where: { id: botId } });
    if (!bot || bot.status !== "active") {
      throw new ApiError(404, "bot_not_found", "Active bot not found");
    }
    return bot;
  }

  private pendingView(botId: string, state: "starting" | "failed"): ScreenStatusView {
    return {
      botId,
      state,
      width: 1280,
      height: 800,
      display: -1,
      viewerUrl: "",
      humanTakeover: false,
      agentInputPaused: false,
      apps: ["chromium", "thunar", "terminal"],
      browserProfileScope: "bot",
      browserSessionScope: "computer",
      browserSessionMechanism: "cookie-broker",
    };
  }

  private toView(botId: string, status: ComputerScreenStatus): ScreenStatusView {
    const query = new URLSearchParams({
      autoconnect: "true",
      resize: "scale",
      path: "websockify",
    });
    return {
      botId,
      state: status.state,
      width: status.width,
      height: status.height,
      display: status.display,
      viewerUrl: `http://${this.screenViewerHost}:${status.viewerPort}/vnc.html?${query}`,
      humanTakeover: status.humanTakeover,
      agentInputPaused: status.agentInputPaused,
      apps: status.apps,
      browserProfileScope: status.browserProfileScope,
      browserSessionScope: status.browserSessionScope,
      browserSessionMechanism: status.browserSessionMechanism,
    };
  }

  private updateControl(
    botId: string,
    endpoint: "takeover" | "pause",
    input: { active: boolean } | { paused: boolean }
  ) {
    return Effect.tryPromise({
      try: async () => {
        const bot = await this.requireActiveBot(botId);
        const response = await this.computerFetch(`/v1/screens/${bot.id}/${endpoint}`, {
          method: "POST",
          body: JSON.stringify({ cwd: bot.defaultDirectory, ...input }),
        });
        if (!response.ok) {
          throw new ApiError(409, "screen_control_rejected", await response.text());
        }
        return this.toView(bot.id, (await response.json()) as ComputerScreenStatus);
      },
      catch: ScreenService.toError,
    });
  }

  private static toError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
