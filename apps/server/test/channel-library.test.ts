import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { ChannelLibraryService, parseLibraryCursor } from "../src/services/channel-library";

const attachment = {
  assetId: "a".repeat(64),
  fileName: "empty.csv",
  mimeType: "text/csv",
  byteSize: 0,
  kind: "file" as const,
};
const row = (sequence: number, value: unknown = attachment) => ({
  messageId: `message-${sequence}`,
  sequence: BigInt(sequence),
  ordinal: 1n,
  attachment: value,
  createdAt: new Date("2026-11-01T00:00:00Z"),
});
const fixture = (rows: ReturnType<typeof row>[], available = true) => {
  const queries: any[] = [],
    channels: any[] = [];
  const service = new ChannelLibraryService({
    channel: {
      findFirst: async (query: unknown) => {
        channels.push(query);
        return available ? { id: "channel" } : null;
      },
    },
    $queryRaw: async (query: unknown) => {
      queries.push(query);
      return rows;
    },
  } as never);
  return { service, queries, channels };
};
describe("conversation Library", () => {
  test("validates bounded two-part keyset cursors", () => {
    expect(parseLibraryCursor(null)).toBeNull();
    expect(parseLibraryCursor("9223372036854775807.999999")).toEqual({
      sequence: 9223372036854775807n,
      ordinal: 999999n,
    });
    for (const cursor of [
      "",
      "0.1",
      "1.0",
      "-1.1",
      "1.5.1",
      "9223372036854775808.1",
      "1.1000000",
      "1;DROP TABLE.1",
    ])
      expect(() => parseLibraryCursor(cursor)).toThrow("Invalid Library page cursor");
  });
  test("limits bot-made files to the authorized conversation and supports empty files", async () => {
    const { service, queries, channels } = fixture([row(100)]);
    const page = await Effect.runPromise(
      service.list("00000000-0000-0000-0000-000000000001", "105.2")
    );
    expect(page.items[0]?.attachment).toEqual(attachment);
    expect(page.nextCursor).toBeNull();
    const sql = queries[0].strings.join("?");
    expect(sql).toContain('message."channelId" = ?::uuid');
    expect(sql).toContain("message.sender = 'agent'");
    expect(sql).toContain('message."sequence", asset.ordinality) <');
    expect(sql).toContain("jsonb_typeof");
    expect(queries[0].values).toContain(105n);
    expect(queries[0].values).toContain(2n);
    expect(queries[0].values).toContain(51);
    expect(channels[0].where.archivedAt).toBeNull();
    expect(channels[0].where.members.some.bot.subagentIdentity).toEqual({ is: null });
  });
  test("advances across malformed legacy attachments and bounds each page", async () => {
    const rows = Array.from({ length: 51 }, (_, i) =>
      row(100 - i, i === 49 ? { broken: true } : attachment)
    );
    const page = await Effect.runPromise(fixture(rows).service.list("channel"));
    expect(page.items).toHaveLength(49);
    expect(page.nextCursor).toBe("51.1");
  });
  test("does not query files for missing or archived conversations", async () => {
    const { service, queries } = fixture([], false);
    await expect(Effect.runPromise(service.list("missing"))).rejects.toThrow("Channel not found");
    expect(queries).toHaveLength(0);
  });
  test("rejects bad cursors before accessing storage", async () => {
    const { service, channels } = fixture([]);
    await expect(Effect.runPromise(service.list("channel", "invalid"))).rejects.toThrow();
    expect(channels).toHaveLength(0);
  });
});
