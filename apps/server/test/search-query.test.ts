import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  prefixTsQuery,
  SearchService,
} from "../src/services/search-service";

describe("search query parsing", () => {
  test.each([
    ["Command K", "Command:* & K"], // one-character terms are not expanded across the lexicon
    ["שלום, world! & (fast)", "שלום:* & world:* & fast:*"],
    ["gesture-0916", "gesture:* & (0916:* | -0916:*)"], // PostgreSQL signed-number tokens
    ["project-1", "project:* & (1 | -1)"],
    ["project-0916abc", "project:* & 0916abc:*"],
  ])("prefixTsQuery(%j) is %j", (input, expected) => {
    expect(prefixTsQuery(input)).toBe(expected);
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
});
