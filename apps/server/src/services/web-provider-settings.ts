import { ApiError } from "@openteam/contracts";
import {
  DEFAULT_FETCH_PROVIDER,
  WEB_PROVIDER_LISTS,
  WEB_TOOLS,
  type WebFetchSettingsView,
  type WebProviderCheckRequest,
  type WebProviderCheckResult,
  type WebProviderFieldsInput,
  type WebProviderInfo,
  type WebProviderState,
  type WebProvidersInput,
  type WebProvidersView,
  type WebSearchSettingsView,
  type WebTool,
  type WebToolCredentials,
  type WebToolInput,
  webProviderInfo,
} from "@openteam/contracts/web-search";
import type { PrismaClient } from "@openteam/db";

const invalid = (message: string) => new ApiError(400, "invalid_web_provider_settings", message);
const ID = "global";
type Client = Pick<PrismaClient, "webSearchSettings" | "webFetchSettings" | "webToolProvider">;
type Row = { secret: string | null; check: WebProviderState["check"] };
type ToolState = { selected: string | null; rows: Map<string, Row> };
type State = Record<WebTool, ToolState>;
export type WebProviderChecker = (request: WebProviderCheckRequest) => Promise<WebProviderCheckResult>;

export function validateWebApiKey(value: unknown): void {
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== "string" ||
      !value.trim() ||
      value.length > 20_000 ||
      /[\x00-\x1f\x7f]/.test(value) ||
      /\s/.test(value.trim()))
  )
    throw invalid("The API key is invalid.");
}

function parseTool(tool: WebTool, input: unknown): WebToolInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid(`${tool} settings must be an object.`);
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["selected", "providers"].includes(key)))
    throw invalid(`Unknown ${tool} setting.`);
  const parsed: WebToolInput = {};
  if (value.selected !== undefined) {
    if (value.selected !== null && !webProviderInfo(tool, value.selected))
      throw invalid(`Choose a ${tool} provider from the list.`);
    parsed.selected = value.selected as string | null;
  }
  if (value.providers !== undefined) {
    if (!value.providers || typeof value.providers !== "object" || Array.isArray(value.providers))
      throw invalid("providers must map provider names to fields.");
    parsed.providers = {};
    for (const [id, fields] of Object.entries(value.providers)) {
      const info = webProviderInfo(tool, id);
      if (!info) throw invalid(`Unknown ${tool} provider.`);
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw invalid("Provider fields must be an object.");
      const entry: WebProviderFieldsInput = {};
      for (const [field, fieldValue] of Object.entries(fields)) {
        if (!info.fields.some((known) => known.id === field)) throw invalid(`${info.name} has no ${field} field.`);
        validateWebApiKey(fieldValue);
        if (fieldValue !== undefined) entry.apiKey = typeof fieldValue === "string" ? fieldValue.trim() : null;
      }
      parsed.providers[id] = entry;
    }
  }
  return parsed;
}

export function parseWebProviderSettings(input: unknown): WebProvidersInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("Web provider settings are required.");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !WEB_TOOLS.includes(key as WebTool))) throw invalid("Unknown web provider setting.");
  const parsed: WebProvidersInput = {};
  for (const tool of WEB_TOOLS) if (value[tool] !== undefined) parsed[tool] = parseTool(tool, value[tool]);
  return parsed;
}

const missingKey = (info: WebProviderInfo, row: Row | undefined) => info.fields.some((field) => field.required) && !row?.secret;
const sameKey = (a: Row | undefined, b: Row | undefined) => (a?.secret ?? null) === (b?.secret ?? null);

/** Deployment-wide web search and fetch configuration; secrets never enter agent data or events. */
export class WebProviderSettingsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly checker?: WebProviderChecker
  ) {}

  private async state(client: Client): Promise<State> {
    const [search, fetch, rows] = await Promise.all([
      client.webSearchSettings.findUnique({ where: { id: ID } }),
      client.webFetchSettings.findUnique({ where: { id: ID } }),
      client.webToolProvider.findMany(),
    ]);
    // Constraints make unknown providers unreachable; fail closed rather than guess one.
    if ((search?.provider && !webProviderInfo("search", search.provider)) || (fetch?.provider && !webProviderInfo("fetch", fetch.provider)))
      throw new ApiError(503, "web_provider_settings_invalid", "Choose web providers again in Settings → Providers.");
    const state: State = {
      search: { selected: search?.provider ?? null, rows: new Map() },
      fetch: { selected: fetch ? (fetch.provider ?? null) : DEFAULT_FETCH_PROVIDER, rows: new Map() },
    };
    for (const row of rows) {
      if (!WEB_TOOLS.includes(row.tool as WebTool)) continue;
      state[row.tool as WebTool].rows.set(row.provider, {
        secret: row.secret,
        check:
          row.checkStatus && row.checkedAt
            ? {
                status: row.checkStatus as "passed" | "failed",
                message: row.checkMessage ?? "",
                checkedAt: row.checkedAt.toISOString(),
              }
            : null,
      });
    }
    return state;
  }

  private viewOf(state: State): WebProvidersView {
    const tool = (name: WebTool) => ({
      selected: state[name].selected,
      providers: Object.fromEntries(
        WEB_PROVIDER_LISTS[name].map((info) => {
          const row = state[name].rows.get(info.id);
          return [
            info.id,
            {
              secretSaved: Boolean(row?.secret),
              ready: !missingKey(info, row),
              check: row?.check ?? null,
            } satisfies WebProviderState,
          ];
        })
      ),
    });
    return { search: tool("search"), fetch: tool("fetch") } as WebProvidersView;
  }

  async view(): Promise<WebProvidersView> {
    return this.viewOf(await this.state(this.prisma));
  }

  /** Internal computer service only. Never return from a public route. */
  async credentials(tool: WebTool): Promise<WebToolCredentials> {
    const state = (await this.state(this.prisma))[tool];
    const row = state.selected ? state.rows.get(state.selected) : undefined;
    return { provider: state.selected, apiKey: row?.secret ?? null };
  }

  async save(input: unknown): Promise<WebProvidersView> {
    const parsed = parseWebProviderSettings(input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize writes across server instances, including the first inserts.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(742310, 1)::text`;
        const state = await this.state(tx);
        for (const tool of WEB_TOOLS) {
          const change = parsed[tool];
          if (!change) continue;
          const changed = new Set<string>();
          for (const [id, fields] of Object.entries(change.providers ?? {})) {
            const current = state[tool].rows.get(id) ?? { secret: null, check: null };
            if (fields.apiKey === undefined || fields.apiKey === current.secret) continue;
            state[tool].rows.set(id, { secret: fields.apiKey, check: null });
            changed.add(id);
          }
          if (change.selected !== undefined) state[tool].selected = change.selected;
          const selected = state[tool].selected;
          const info = selected ? webProviderInfo(tool, selected) : undefined;
          if (info && missingKey(info, state[tool].rows.get(info.id)))
            throw invalid(
              change.providers?.[info.id]?.apiKey === null
                ? `${info.name} is used for ${tool}. Choose another ${tool} provider before removing its API key.`
                : `Add the ${info.name} API key to use it for ${tool}.`
            );
          for (const id of changed) {
            const row = state[tool].rows.get(id)!;
            await tx.webToolProvider.upsert({
              where: { tool_provider: { tool, provider: id } },
              create: { tool, provider: id, secret: row.secret },
              update: { secret: row.secret, checkStatus: null, checkMessage: null, checkedAt: null },
            });
          }
          const table = tool === "search" ? tx.webSearchSettings : tx.webFetchSettings;
          await (table as typeof tx.webSearchSettings).upsert({
            where: { id: ID },
            create: { id: ID, provider: selected },
            update: { provider: selected, apiKey: null },
          });
        }
        return this.viewOf(state);
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Database errors can include write arguments; never expose or log secrets.
      throw new ApiError(503, "web_provider_settings_save_failed", "Could not save web provider settings. Check the database connection and retry.");
    }
  }

  /** Runs a real search or fetch with the saved configuration and stores the outcome. */
  async check(input: unknown): Promise<WebProvidersView> {
    const { tool, provider } = (input ?? {}) as Record<string, unknown>;
    if (!WEB_TOOLS.includes(tool as WebTool)) throw invalid("Choose search or fetch.");
    const info = webProviderInfo(tool as WebTool, provider);
    if (!info) throw invalid(`Unknown ${tool} provider.`);
    const before = (await this.state(this.prisma))[tool as WebTool].rows.get(info.id);
    if (missingKey(info, before)) throw invalid(`Add the ${info.name} API key before checking it.`);
    if (!this.checker) throw new ApiError(503, "web_provider_check_unavailable", "Connection checks are unavailable.");
    let result: WebProviderCheckResult;
    try {
      result = await this.checker({ tool: tool as WebTool, provider: info.id, apiKey: before?.secret ?? null });
    } catch {
      throw new ApiError(503, "web_provider_check_unavailable", "Couldn't reach the OpenTeam computer to run the check. Try again shortly.");
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(742310, 1)::text`;
      // Discard the result if the provider's key changed while it was being checked.
      const current = (await this.state(tx))[tool as WebTool].rows.get(info.id);
      if (!sameKey(before, current)) return;
      const check = { checkStatus: result.ok ? "passed" : "failed", checkMessage: result.message.slice(0, 500), checkedAt: new Date() };
      await tx.webToolProvider.upsert({
        where: { tool_provider: { tool: tool as WebTool, provider: info.id } },
        create: { tool: tool as WebTool, provider: info.id, secret: null, ...check },
        update: check,
      });
    });
    return this.view();
  }

  /** Legacy `/web-search` and `/web-fetch` views for clients older than Settings → Providers. */
  async legacyView(tool: WebTool): Promise<WebSearchSettingsView | WebFetchSettingsView> {
    const state = (await this.state(this.prisma))[tool];
    const info = state.selected ? webProviderInfo(tool, state.selected) : undefined;
    const row = info ? state.rows.get(info.id) : undefined;
    return { provider: state.selected, hasApiKey: Boolean(row?.secret), configured: Boolean(info && !missingKey(info, row)) };
  }

  /** Maps a legacy `{provider, apiKey?}` body onto the provider settings. */
  async legacySave(tool: WebTool, input: unknown): Promise<WebSearchSettingsView | WebFetchSettingsView> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid(`Web ${tool} settings are required.`);
    const { provider, apiKey, ...rest } = input as Record<string, unknown>;
    if (Object.keys(rest).length) throw invalid(`Unknown web ${tool} setting.`);
    const info = provider === null ? undefined : webProviderInfo(tool, provider);
    if (provider !== null && !info) throw invalid(`Choose a valid ${tool} provider.`);
    if (apiKey !== undefined && !info?.fields.length) throw invalid("This provider does not use an API key.");
    await this.save({
      [tool]: {
        selected: apiKey === null ? null : (provider as string | null),
        ...(apiKey !== undefined && info ? { providers: { [info.id]: { apiKey } } } : {}),
      },
    });
    return this.legacyView(tool);
  }
}
