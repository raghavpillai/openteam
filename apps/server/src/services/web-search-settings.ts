import { ApiError } from "@openteam/contracts";
import {
  isSearchProvider,
  type SearchProvider,
  type WebSearchSettingsInput,
  type WebSearchSettingsView,
} from "@openteam/contracts/web-search";
import type { PrismaClient } from "@openteam/db";

const invalid = (message: string) => new ApiError(400, "invalid_web_search_settings", message);
const settingsId = "global";
type StoredSettings = { provider: string | null; apiKey: string | null };

export function parseWebSearchSettings(input: unknown): WebSearchSettingsInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw invalid("Web search settings are required.");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["provider", "apiKey"].includes(key)))
    throw invalid("Unknown web search setting.");
  if (value.provider !== null && !isSearchProvider(value.provider))
    throw invalid("Choose Exa, Tavily, Brave Search, or Bing via SerpApi.");
  if (
    value.apiKey !== undefined &&
    value.apiKey !== null &&
    (typeof value.apiKey !== "string" ||
      !value.apiKey.trim() ||
      value.apiKey.length > 20_000 ||
      /[\x00-\x1f\x7f]/.test(value.apiKey) ||
      /\s/.test(value.apiKey.trim()))
  )
    throw invalid("The search API key is invalid.");
  if (value.provider === null && typeof value.apiKey === "string")
    throw invalid("Select a provider before saving an API key.");
  return {
    provider: value.provider,
    ...(value.apiKey !== undefined
      ? { apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : null }
      : {}),
  };
}

/** Deployment-wide configuration; credentials never enter agent data or events. */
export class WebSearchSettingsService {
  constructor(private readonly prisma: PrismaClient) {}

  private provider(settings: StoredSettings | null): SearchProvider | null {
    if (!settings?.provider) return null;
    if (!isSearchProvider(settings.provider))
      throw new ApiError(
        503,
        "web_search_settings_invalid",
        "Save a valid search provider in Server settings."
      );
    return settings.provider;
  }

  private viewOf(settings: StoredSettings | null): WebSearchSettingsView {
    const provider = this.provider(settings);
    const hasApiKey = Boolean(settings?.apiKey);
    return { provider, hasApiKey, configured: Boolean(provider && hasApiKey) };
  }

  async view(): Promise<WebSearchSettingsView> {
    return this.viewOf(
      await this.prisma.webSearchSettings.findUnique({ where: { id: settingsId } })
    );
  }

  /** Internal computer service only. Never return from the public settings route. */
  async credentials(): Promise<{ provider: SearchProvider | null; apiKey: string | null }> {
    const settings = await this.prisma.webSearchSettings.findUnique({ where: { id: settingsId } });
    const provider = this.provider(settings);
    return {
      provider,
      apiKey: provider ? (settings?.apiKey ?? null) : null,
    };
  }

  async save(input: unknown): Promise<WebSearchSettingsView> {
    const parsed = parseWebSearchSettings(input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize provider/key updates across server instances, including first insert.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(742310, 1)::text`;
        const previous = await tx.webSearchSettings.findUnique({ where: { id: settingsId } });
        const apiKey =
          parsed.provider === null || parsed.apiKey === null
            ? null
            : parsed.apiKey === undefined
              ? previous?.provider === parsed.provider
                ? previous.apiKey
                : null
              : parsed.apiKey;
        const data = { provider: parsed.provider, apiKey };
        const saved = await tx.webSearchSettings.upsert({
          where: { id: settingsId },
          create: { id: settingsId, ...data },
          update: data,
        });
        return this.viewOf(saved);
      });
    } catch {
      // Database errors can include write arguments; never expose or log the API key.
      throw new ApiError(
        503,
        "web_search_settings_save_failed",
        "Could not save web search settings. Check the database connection and retry."
      );
    }
  }
}
