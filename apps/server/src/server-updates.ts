import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ApiError,
  type ServerUpdateHeartbeat,
  type ServerUpdateRequest,
  type ServerUpdateView,
} from "@openteam/contracts";
import {
  compareOpenTeamVersions,
  normalizeOpenTeamVersion,
} from "@openteam/contracts/version-compatibility";
import { json } from "./http";

const AGENT_TIMEOUT = 30_000;

/** The API queues work; only the installation's host CLI can execute it. */
export class ServerUpdates {
  private heartbeatAt = 0;
  private request: ServerUpdateRequest | null;
  private readonly file: string;

  constructor(
    private readonly directory: string,
    private readonly currentVersion: string,
    private readonly now = Date.now
  ) {
    this.file = join(directory, "server-update.json");
    try {
      this.request = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.request = null;
    }
  }

  private save() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.request), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  view(): ServerUpdateView {
    const available = this.heartbeatAt > 0 && this.now() - this.heartbeatAt < AGENT_TIMEOUT;
    const request = this.request;
    const active = request?.status === "queued" || request?.status === "running";
    return {
      updaterAvailable: available,
      status: active
        ? "updating"
        : request?.status === "complete"
          ? "updated"
          : request?.status === "error"
            ? "error"
            : available
              ? "ready"
              : "unavailable",
      targetVersion: request?.targetVersion ?? null,
      phase: request?.phase ?? null,
      message: active
        ? available
          ? request.message
          : "Waiting for the server updater to reconnect…"
        : (request?.message ??
          (available
            ? "Updates this connected server"
            : "Run openteam start on the server to enable updates from the app.")),
      jobId: request?.jobId ?? request?.id ?? null,
      safeToCloseDesktop: Boolean(active),
    };
  }

  start(input: unknown): ServerUpdateView {
    const body = input as Record<string, unknown> | null;
    const version =
      typeof body?.targetVersion === "string" ? normalizeOpenTeamVersion(body.targetVersion) : null;
    if (
      !version ||
      version.includes("-") ||
      (compareOpenTeamVersions(version, this.currentVersion) ?? 0) <= 0
    )
      throw new ApiError(400, "invalid_update_version", "Choose a newer stable server release.");
    // No destination, executable, repository, or flags can be supplied by clients.
    if (Object.keys(body!).some((key) => key !== "targetVersion"))
      throw new ApiError(400, "invalid_update_request", "Only targetVersion is accepted.");
    if (this.request?.status === "queued" || this.request?.status === "running") {
      if (this.request.targetVersion !== version)
        throw new ApiError(409, "update_in_progress", "A server update is already in progress.");
      return this.view();
    }
    if (!this.view().updaterAvailable)
      throw new ApiError(
        503,
        "updater_unavailable",
        "Run openteam start on the server to enable updates from the app."
      );
    this.request = {
      id: randomUUID(),
      targetVersion: version,
      status: "queued",
      phase: "checking",
      message: "Update requested. Waiting for the server updater…",
      jobId: null,
    };
    this.save();
    return this.view();
  }

  heartbeat(input: unknown): { request: ServerUpdateRequest | null } {
    const body = input as ServerUpdateHeartbeat | null;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      (body.status !== undefined && !["running", "complete", "error"].includes(body.status)) ||
      (body.requestId !== undefined && typeof body.requestId !== "string") ||
      (body.message !== undefined && typeof body.message !== "string") ||
      (body.phase !== undefined && typeof body.phase !== "string") ||
      (body.jobId != null && typeof body.jobId !== "string")
    )
      throw new ApiError(400, "invalid_update_heartbeat", "Invalid update progress.");
    this.heartbeatAt = this.now();
    const request = this.request;
    if (
      request &&
      body.requestId === request.id &&
      body.status &&
      (request.status === "queued" || request.status === "running")
    ) {
      this.request = {
        ...request,
        status: body.status,
        phase: body.phase?.slice(0, 80) ?? request.phase,
        message: body.message?.slice(0, 1000) ?? request.message,
        jobId: body.jobId ?? request.jobId,
      };
      this.save();
    }
    return { request: this.request };
  }
}

export async function serverUpdateRoute(
  request: Request,
  updates: ServerUpdates,
  authenticatedSessionId: string | null
): Promise<Response> {
  if (request.method === "GET") return json(updates.view());
  if (request.method !== "POST") return json({ error: { code: "method_not_allowed" } }, 405);
  // Require owner sign-in and an explicit bearer credential, including in auth-disabled dev mode.
  // Cookie-only cross-site requests must never start host maintenance.
  if (
    !authenticatedSessionId ||
    !/^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "")
  )
    throw new ApiError(403, "update_auth_required", "Sign in to update this server.");
  return json(updates.start(await request.json()), 202);
}
