import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  normalizeSearchQuery,
  prefixTsQuery,
  SEARCH_CANDIDATE_LIMIT,
  SEARCH_RESULT_URL_MAX_LENGTH,
  SearchService,
} from "../src/services/search-service";

describe("search query parsing", () => {
  test("normalizes whitespace and creates safe prefix terms", () => {
    expect(normalizeSearchQuery("  Command   K  ")).toBe("Command K");
    expect(prefixTsQuery("Command K")).toBe("Command:* & K");
  });

  test("supports unicode words and drops tsquery punctuation", () => {
    expect(prefixTsQuery("שלום, world! & (fast)")).toBe("שלום:* & world:* & fast:*");
  });

  test("does not expand a one-character term across the full lexicon", () => {
    expect(prefixTsQuery("a command")).toBe("a & command:*");
  });

  test("keeps the FTS predicate inline and bounds expensive ranking", async () => {
    let sql = "";
    const prisma = {
      $queryRaw: async (query: { strings?: readonly string[] }) => {
        sql = query.strings?.join("?") ?? String(query);
        return [];
      },
    };
    const service = new SearchService(prisma as never);

    await Effect.runPromise(service.search("missing phrase", "all"));

    expect(sql).toContain('document."searchVector" @@ to_tsquery');
    expect(sql).toContain("recent_documents AS MATERIALIZED");
    expect(sql).toContain("exact_title_documents AS MATERIALIZED");
    expect(sql).toContain("candidate_documents AS MATERIALIZED");
    expect(sql).toContain("FROM candidate_documents AS document");
    expect(sql).toContain('md5(lower(document."title")) = md5(lower(');
    expect(sql).toContain('lower(document."title") = lower(');
    expect(SEARCH_CANDIDATE_LIMIT).toBe(512);
    expect(SEARCH_RESULT_URL_MAX_LENGTH).toBe(8_192);
    expect(sql).toContain('char_length(document."url") <=');
    expect(sql).not.toContain("CROSS JOIN search_input");
  });

  test("keeps the exact-title lane compact and collision-safe", async () => {
    const migration = await Bun.file(
      new URL("../../../packages/db/prisma/sql/raw-schema.sql", import.meta.url)
    ).text();

    expect(migration).toContain('"SearchDocument_title_exact_hash_idx"');
    expect(migration).toContain('md5(lower("title"))');
  });

  test("does not invoke to_tsquery for an empty browse request", async () => {
    let sql = "";
    const prisma = {
      $queryRaw: async (query: { strings?: readonly string[] }) => {
        sql = query.strings?.join("?") ?? String(query);
        return [];
      },
    };
    const service = new SearchService(prisma as never);

    await Effect.runPromise(service.search("", "all"));

    expect(sql).not.toContain('document."searchVector" @@ to_tsquery');
  });

  test("authorizes and navigates routines through either a Bot or group owner", async () => {
    let sql = "";
    const prisma = {
      $queryRaw: async (query: { strings?: readonly string[] }) => {
        sql = query.strings?.join("?") ?? String(query);
        return [];
      },
    };
    const service = new SearchService(prisma as never);

    await Effect.runPromise(service.search("daily report", "routines"));

    expect(sql).toContain("visible_bots AS MATERIALIZED");
    expect(sql).toContain("visible_channels AS MATERIALIZED");
    expect(sql).toContain("document.\"kind\" = 'routine'");
    expect(sql).toContain('document."botId" IN (SELECT bot."id" FROM visible_bots AS bot)');
    expect(sql).toContain('document."channelId" IN (');
    expect(sql).toContain('coalesce(document."channelId", direct_channel."channelId")');
    expect(sql).toContain('coalesce(bot."name", channel."name")');
  });

  test("projects canonical attachments with a legacy-image fallback", async () => {
    const migration = await Bun.file(
      new URL("../../../packages/db/prisma/sql/raw-schema.sql", import.meta.url)
    ).text();

    expect(migration).toContain('NEW."channelId", NEW."botId"');
    expect(migration).toContain("NEW.\"metadata\"::jsonb -> 'attachments'");
    expect(migration).toContain("attachment ->> 'fileName'");
    expect(migration).toContain("attachment ->> 'assetId'");
    expect(migration).toContain(
      "ELSIF jsonb_typeof(NEW.\"metadata\"::jsonb -> 'images') = 'array'"
    );
    expect(migration).toContain("openteam.search_reindex");
  });
});
