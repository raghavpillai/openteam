import { ApiError } from "@openteam/contracts";
import {
  isFetchProvider,
  type FetchProvider,
  type WebFetchSettingsInput,
  type WebFetchSettingsView,
} from "@openteam/contracts/web-search";
import type { PrismaClient } from "@openteam/db";
import { validateWebApiKey } from "./web-search-settings";

export function parseWebFetchSettings(input: unknown): WebFetchSettingsInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ApiError(400, "invalid_web_fetch_settings", "Web fetch settings are required.");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["provider", "apiKey"].includes(key)) ||
    (value.provider !== null && !isFetchProvider(value.provider))
  )
    throw new ApiError(
      400,
      "invalid_web_fetch_settings",
      "Choose built-in HTTP fetch, Exa Contents, or Tavily Extract."
    );
  validateWebApiKey(value.apiKey, "fetch");
  if ((value.provider === "builtin" || value.provider === null) && typeof value.apiKey === "string")
    throw new ApiError(
      400,
      "invalid_web_fetch_settings",
      "Select an API-backed fetch provider before saving an API key."
    );
  return {
    provider: value.provider,
    ...(value.apiKey !== undefined
      ? { apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : null }
      : {}),
  };
}

export class WebFetchSettingsService {
  constructor(private readonly prisma: PrismaClient) {}
  private viewOf(row: { provider: string; apiKey: string | null } | null): WebFetchSettingsView {
    const provider = row?.provider ?? null;
    if (provider !== null && !isFetchProvider(provider))
      throw new ApiError(
        503,
        "invalid_web_fetch_settings",
        "Save a valid web fetch provider in Server settings."
      );
    const hasApiKey = Boolean(row?.apiKey);
    return {
      provider,
      hasApiKey,
      configured: provider === "builtin" || Boolean(provider && hasApiKey),
    };
  }
  async view(): Promise<WebFetchSettingsView> {
    return this.viewOf(await this.prisma.webFetchSettings.findUnique({ where: { id: "global" } }));
  }
  async credentials(): Promise<{ provider: FetchProvider | null; apiKey: string | null }> {
    const row = await this.prisma.webFetchSettings.findUnique({ where: { id: "global" } });
    const { provider } = this.viewOf(row);
    return { provider, apiKey: provider === "builtin" ? null : (row?.apiKey ?? null) };
  }
  async save(input: unknown): Promise<WebFetchSettingsView> {
    const parsed = parseWebFetchSettings(input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(742310, 2)::text`;
        if (parsed.provider === null) {
          await tx.webFetchSettings.deleteMany({ where: { id: "global" } });
          return this.viewOf(null);
        }
        const previous = await tx.webFetchSettings.findUnique({ where: { id: "global" } });
        const apiKey =
          parsed.provider === "builtin" || parsed.apiKey === null
            ? null
            : parsed.apiKey === undefined
              ? previous?.provider === parsed.provider
                ? previous.apiKey
                : null
              : parsed.apiKey;
        const data = { provider: parsed.provider, apiKey };
        return this.viewOf(
          await tx.webFetchSettings.upsert({
            where: { id: "global" },
            create: { id: "global", ...data },
            update: data,
          })
        );
      });
    } catch {
      throw new ApiError(
        503,
        "web_fetch_settings_save_failed",
        "Could not save web fetch settings. Check the database connection and retry."
      );
    }
  }
}
