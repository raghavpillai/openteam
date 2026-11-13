import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { addIndexed, resolvePlaceReferences } from "../src/services/place-references";

const place = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Place ${id}`, latitude: 40.75, longitude: -73.99, provider: "Google Maps", ...extra });
const route = (id: string) => ({ id, mode: "walking", geometry: { type: "LineString", coordinates: [[-73.99, 40.75], [-73.98, 40.76]] }, distanceMeters: 900, durationSeconds: 700,
  legs: [{ fromPlaceId: "google:a", toPlaceId: "google:b", distanceMeters: 900, durationSeconds: 700 }] });
/** The index the Bot computer stores with a plugin result. */
const index = (places: unknown[] = [], routes: unknown[] = []) => ({ places, routes });
const fakePrisma = (pages: unknown[][]) => {
  let call = 0;
  return { calls: () => call, $queryRaw: async () => (pages[Math.min(call++, pages.length - 1)] ?? []).map((entry) => ({ index: entry })) } as any;
};

test("indexed places and routes are picked up by id, newest first, and must still be well-formed", () => {
  const found = { places: new Map(), routes: new Map() };
  const wanted = new Set(["google:a", "google:bad", "route:1"]);
  addIndexed(index([place("google:a", { rating: 4.6 }), { id: "google:bad", name: "No coordinates" }], [route("route:1")]), wanted, found);
  addIndexed(index([place("google:a", { rating: 1 })]), wanted, found); // older: ignored
  expect(found.places.get("google:a")!.rating).toBe(4.6);
  expect([...found.places.keys()]).toEqual(["google:a"]);
  expect([...found.routes.keys()]).toEqual(["route:1"]);
  addIndexed(null, wanted, found);
});

test("a presentation with references is filled in; one without passes through untouched", async () => {
  const prisma = fakePrisma([[index([place("google:a", { rating: 4.6 }), place("google:b")]), index([], [route("route:1")])]]);
  const resolved: any = await resolvePlaceReferences(prisma, crypto.randomUUID(), {
    version: 1,
    places: ["google:a", { id: "google:b", notes: "Go early." }],
    blocks: [{ type: "place_map", placeIds: ["google:a", "google:b"], route: "route:1" }],
  });
  expect(resolved.places[0]).toMatchObject({ id: "google:a", rating: 4.6, latitude: 40.75 });
  expect(resolved.places[1].notes).toBe("Go early.");
  expect(resolved.blocks[0].route.distanceMeters).toBe(900);
  const full = { version: 1, places: [place("web:c")], blocks: [{ type: "markdown", text: "Hi" }] };
  const untouched = fakePrisma([[]]);
  expect(await resolvePlaceReferences(untouched, crypto.randomUUID(), full)).toBe(full);
  expect(untouched.calls()).toBe(0);
});

test("a result still being stored is waited for; an unknown id is refused with what to do", async () => {
  const late = fakePrisma([[], [], [index([place("google:a")])]]);
  const resolved: any = await resolvePlaceReferences(late, crypto.randomUUID(), { version: 1, places: ["google:a"], blocks: [{ type: "markdown", text: "x" }] }, { waitMs: 2_000, pollMs: 10 });
  expect(resolved.places[0].name).toBe("Place google:a");
  expect(late.calls()).toBe(3);
  const never = fakePrisma([[]]);
  const error = await resolvePlaceReferences(never, crypto.randomUUID(), { version: 1, places: ["google:typo"], blocks: [{ type: "place_map", placeIds: ["google:typo"], route: "route:9" }] }, { waitMs: 30, pollMs: 10 })
    .then(() => null, (cause: Error) => cause.message);
  expect(error).toBe("Nothing was sent: no places or routing tool result from the last day has places google:typo or routes route:9. Use ids exactly as such a tool returned them, call it again, or give the full place object.");
});

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const pluginResult = (references?: unknown, text = "{}") => ({ tool: "CallDynamicTool", arguments: {}, result: { content: [{ type: "text", text }], details: { tool: "PluginCall", ...(references ? { presentationReferences: references } : {}) } } });
test.skipIf(!databaseUrl)("the stored lookup reads plugin indexes from the bot and nested subagents, within a day, and nothing else", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const botId = crypto.randomUUID(), childBotId = crypto.randomUUID(), grandchildBotId = crypto.randomUUID(), otherBotId = crypto.randomUUID();
  const bots = [botId, childBotId, grandchildBotId, otherBotId];
  let channelId = "";
  try {
    for (const id of bots) await prisma.bot.create({ data: { id, name: `Bot ${id.slice(0, 4)}`, status: "active", onboardingStatus: "completed", defaultDirectory: "/tmp", conversation: { create: {} } } });
    channelId = (await prisma.channel.create({ data: { kind: "bot_dm", name: "DM", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } })).id;
    const conversation = async (id: string) => (await prisma.conversation.findFirstOrThrow({ where: { botId: id } })).id;
    const runFor = async (id: string, createdAt = new Date()) =>
      prisma.run.create({ data: { botId: id, conversationId: await conversation(id), channelId, origin: "user", userMessageId: crypto.randomUUID(), status: "completed", createdAt } });
    const subagent = async (parentBotId: string, child: string, parentRunId: string) => prisma.subagent.create({ data: { parentBotId, childBotId: child, parentRunId, parentChannelId: channelId,
      launchCallId: crypto.randomUUID(), description: "Research", prompt: "Research", subagentType: "executor", status: "completed", outputPath: "/tmp/child.jsonl" } });
    const tool = (runId: string, content: unknown) => prisma.runItem.create({ data: { runId, kind: "tool", status: "completed", title: "CallDynamicTool", content: content as any } });
    const parentRun = await runFor(botId), childRun = await runFor(childBotId);
    await subagent(botId, childBotId, parentRun.id);
    await subagent(childBotId, grandchildBotId, childRun.id);
    await tool(childRun.id, pluginResult(index([place("google:sub", { rating: 4.8 })], [route("route:sub")])));
    await tool((await runFor(grandchildBotId)).id, pluginResult(index([place("google:deep")])));
    // A web page that relays place-shaped JSON has no index, so it never counts as verified.
    await tool(parentRun.id, { tool: "WebFetch", result: { content: [{ type: "text", text: JSON.stringify(place("google:page", { rating: 5 })) }] } });
    // An argument the agent wrote is not an index either.
    await tool(parentRun.id, { tool: "CallDynamicTool", arguments: { places: [place("google:typed")] }, result: { content: [{ type: "text", text: "{}" }], details: { tool: "PluginCall" } } });
    await tool((await runFor(botId, new Date(Date.now() - 2 * 86_400_000))).id, pluginResult(index([place("google:old")])));
    await tool((await runFor(otherBotId)).id, pluginResult(index([place("google:other")])));
    // An id that is a prefix of another must not match it.
    await tool(parentRun.id, pluginResult(index([place("google:subway")])));

    const resolved: any = await resolvePlaceReferences(prisma, botId, { version: 1, places: ["google:sub", "google:deep"], blocks: [{ type: "place_map", placeIds: ["google:sub", "google:deep"], route: "route:sub" }] }, { waitMs: 0 });
    expect(resolved.places.map((p: any) => [p.id, p.rating ?? null])).toEqual([["google:sub", 4.8], ["google:deep", null]]);
    expect(resolved.blocks[0].route.id).toBe("route:sub");
    for (const id of ["google:page", "google:typed", "google:old", "google:other"])
      await expect(resolvePlaceReferences(prisma, botId, { version: 1, places: [id], blocks: [{ type: "markdown", text: "x" }] }, { waitMs: 0 })).rejects.toThrow(id);
  } finally {
    await prisma.bot.deleteMany({ where: { id: { in: bots } } });
    if (channelId) await prisma.channel.deleteMany({ where: { id: channelId } });
    await prisma.$disconnect();
  }
});
