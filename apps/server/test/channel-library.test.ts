import { expect, test } from "bun:test";
import { Effect } from "effect";
import { ChannelLibraryService, parseLibraryCursor } from "../src/services/channel-library";

test("Library cursors are bounded two-part keysets", () => {
  expect(parseLibraryCursor(null)).toBeNull();
  expect(parseLibraryCursor("9223372036854775807.999999")).toEqual({ sequence: 9223372036854775807n, ordinal: 999999n });
  for (const cursor of ["", "0.1", "1.0", "-1.1", "1.5.1", "9223372036854775808.1", "1.1000000", "1;DROP TABLE.1"])
    expect(() => parseLibraryCursor(cursor)).toThrow("Invalid Library page cursor");
});

test("the Library lists only bot-made files in the authorized conversation and supports empty files", async () => {
  const attachment = { assetId: "a".repeat(64), fileName: "empty.csv", mimeType: "text/csv", byteSize: 0, kind: "file" as const };
  const queries: any[] = [], channels: any[] = [];
  const service = new ChannelLibraryService({
    channel: { findFirst: async (query: unknown) => { channels.push(query); return { id: "channel" }; } },
    $queryRaw: async (query: unknown) => { queries.push(query); return [{ messageId: "message-100", sequence: 100n, ordinal: 1n, attachment, createdAt: new Date() }]; },
  } as never);
  const page = await Effect.runPromise(service.list("00000000-0000-0000-0000-000000000001", "105.2"));
  expect(page.items[0]?.attachment).toEqual(attachment);
  expect(page.nextCursor).toBeNull();
  const sql = queries[0].strings.join("?");
  for (const part of ['message."channelId" = ?::uuid', "message.sender = 'agent'", 'message."sequence", asset.ordinality) <', "jsonb_typeof"]) expect(sql).toContain(part);
  expect(queries[0].values).toEqual(expect.arrayContaining([105n, 2n, 51]));
  expect(channels[0].where.archivedAt).toBeNull();
  expect(channels[0].where.members.some.bot.subagentIdentity).toEqual({ is: null });
});
