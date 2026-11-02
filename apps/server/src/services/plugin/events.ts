import { PLUGIN_EVENT_POLL_DEFAULT_SECONDS } from "@openteam/plugin-sdk";
import { Prisma, type PrismaClient } from "@openteam/db";
import { parseAutomationEvent, type AutomationEvent } from "@openteam/messaging";
import { toJson } from "../service-utils";
import { definitionFromManifest, jsonObject } from "./values";

/** The fields a packaged connector call needs; see PluginTransport.callHostTool. */
export type PollableConnection = {
  id: string;
  configuration: Prisma.JsonValue;
  credentials: Prisma.JsonValue;
  runtimeGeneration: number;
};
type CallHostTool = (
  connection: PollableConnection,
  toolName: string,
  args: Record<string, unknown>
) => Promise<unknown>;
type DispatchEvent = (event: AutomationEvent) => Promise<unknown>;

const MAX_EVENTS_PER_POLL = 50;
const TICK_MS = 15_000;
const FAILURE_LOG_INTERVAL_MS = 10 * 60_000;

/** A connector tool result is MCP content: JSON text, or structuredContent. */
export const parsePollResult = (raw: unknown): { events: unknown[]; cursor: unknown } => {
  const result = jsonObject(raw);
  const text = Array.isArray(result.content)
    ? result.content
        .map((part) => jsonObject(part))
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => String(part.text))
        .join("\n")
    : "";
  if (result.isError === true) throw new Error(text.slice(0, 500) || "The event poll failed");
  let value: unknown = result.structuredContent;
  if (value === undefined) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("The event poll returned unreadable output");
    }
  }
  const body = jsonObject(value);
  if (!Array.isArray(body.events)) throw new Error("The event poll returned no events list");
  return { events: body.events, cursor: body.cursor ?? null };
};

/**
 * Deployment-wide plugin event sources. A packaged connector that declares
 * `events.pollTool` is called on its interval with the last cursor it returned.
 * Each returned event runs every matching routine once (delivery IDs dedupe
 * repeats), and only then is the new cursor saved.
 */
export class PluginEventPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private readonly failureLoggedAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly callHostTool: CallHostTool,
    private readonly dispatch: DispatchEvent,
    private readonly now: () => Date = () => new Date()
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollDue(), TICK_MS);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  pollDue(): Promise<void> {
    // One pass at a time in this process; the claim below covers other processes.
    // A database outage skips this pass; the next tick retries.
    this.running ??= this.pollAll()
      .catch((error) => {
        console.warn(`Plugin event poll failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async pollAll() {
    const connections = await this.prisma.pluginConnection.findMany({
      where: { status: "ready", transport: "stdio", installation: { status: "installed" } },
      select: {
        id: true,
        alias: true,
        connectorKey: true,
        configuration: true,
        credentials: true,
        runtimeGeneration: true,
        eventCursor: true,
        installation: { select: { pluginKey: true, manifest: true } },
      },
    });
    for (const connection of connections) {
      const events = definitionFromManifest(connection.installation.manifest)?.connections.find(
        (connector) => connector.key === connection.connectorKey
      )?.events;
      if (!events) continue;
      const label = `${connection.installation.pluginKey}/${connection.alias}`;
      try {
        await this.pollConnection(connection, events, label);
        this.failureLoggedAt.delete(connection.id);
      } catch (error) {
        const last = this.failureLoggedAt.get(connection.id) ?? 0;
        if (this.now().getTime() - last >= FAILURE_LOG_INTERVAL_MS) {
          this.failureLoggedAt.set(connection.id, this.now().getTime());
          console.warn(
            `Plugin event poll failed for ${label}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }

  private async pollConnection(
    connection: PollableConnection & { eventCursor: Prisma.JsonValue | null },
    events: { pollTool: string; source: string; intervalSeconds?: number },
    label: string
  ) {
    const now = this.now();
    const interval = (events.intervalSeconds ?? PLUGIN_EVENT_POLL_DEFAULT_SECONDS) * 1000;
    // A conditional claim keeps concurrent server processes from polling one account twice.
    const claimed = await this.prisma.pluginConnection.updateMany({
      where: {
        id: connection.id,
        OR: [
          { eventsPolledAt: null },
          { eventsPolledAt: { lte: new Date(now.getTime() - interval + TICK_MS / 2) } },
        ],
      },
      data: { eventsPolledAt: now },
    });
    if (!claimed.count) return;
    const result = parsePollResult(
      await this.callHostTool(connection, events.pollTool, {
        cursor: connection.eventCursor ?? null,
      })
    );
    for (const raw of result.events.slice(0, MAX_EVENTS_PER_POLL)) {
      let event: AutomationEvent;
      try {
        // The manifest, not the connector's output, decides which trigger type an event can fire.
        event = parseAutomationEvent({ ...jsonObject(raw), source: events.source });
      } catch (error) {
        console.warn(
          `Plugin event from ${label} was rejected: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
      // A dispatch failure leaves the cursor in place, so the poll is retried.
      await this.dispatch(event);
    }
    await this.prisma.pluginConnection.updateMany({
      where: { id: connection.id, runtimeGeneration: connection.runtimeGeneration },
      data: { eventCursor: result.cursor === null ? Prisma.DbNull : toJson(result.cursor) },
    });
  }
}
