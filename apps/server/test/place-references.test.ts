import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { collectReferences, resolvePlaceReferences } from "../src/services/place-references";

const place = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Place ${id}`, latitude: 40.75, longitude: -73.99, provider: "Google Maps", ...extra });
const route = (id: string) => ({ id, mode: "walking", geometry: { type: "LineString", coordinates: [[-73.99, 40.75], [-73.98, 40.76]] }, distanceMeters: 900, durationSeconds: 700,
  legs: [{ fromPlaceId: "google:a", toPlaceId: "google:b", distanceMeters: 900, durationSeconds: 700 }] });
/** A stored MCP tool result: the tool's JSON travels as text inside content[]. */
const mcpResult = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fakePrisma = (pages: unknown[][]) => {
  let call = 0;
  return { calls: () => call, $queryRaw: async () => (pages[Math.min(call++, pages.length - 1)] ?? []).map((result) => ({ result })) } as any;
};

test("references are found inside MCP text results, and only well-formed places and routes count", () => {
  const found = { places: new Map(), routes: new Map() };
  collectReferences(
    mcpResult({ results: [{ place: place("google:a"), distanceMeters: 40 }, { place: { id: "google:bad", name: "No coordinates" } }], route: route("route:1") }),
    new Set(["google:a", "google:bad", "route:1"]),
    found
  );
  expect([...found.places.keys()]).toEqual(["google:a"]);
  expect([...found.routes.keys()]).toEqual(["route:1"]);
  // Malformed text and deep nesting are ignored, not thrown.
  collectReferences({ content: [{ text: "{not json" }] }, new Set(["x"]), found);
});

test("a presentation with references is filled in; one without passes through untouched", async () => {
  const prisma = fakePrisma([[mcpResult({ results: [{ place: place("google:a", { rating: 4.6 }) }, { place: place("google:b") }] }), mcpResult({ route: route("route:1") })]]);
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
  const late = fakePrisma([[], [], [mcpResult({ place: place("google:a") })]]);
  const resolved: any = await resolvePlaceReferences(late, crypto.randomUUID(), { version: 1, places: ["google:a"], blocks: [{ type: "markdown", text: "x" }] }, { waitMs: 2_000, pollMs: 10 });
  expect(resolved.places[0].name).toBe("Place google:a");
  expect(late.calls()).toBe(3);
  const never = fakePrisma([[]]);
  const error = await resolvePlaceReferences(never, crypto.randomUUID(), { version: 1, places: ["google:typo"], blocks: [{ type: "place_map", placeIds: ["google:typo"], route: "route:9" }] }, { waitMs: 30, pollMs: 10 })
    .then(() => null, (cause: Error) => cause.message);
  expect(error).toBe("Nothing was sent: no tool result in this conversation has places google:typo or routes route:9. Use ids exactly as a tool returned them, call the tool again, or give the full place object.");
});

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)("the stored lookup finds a subagent's tool results, ignores arguments, and stays within a day", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const botId = crypto.randomUUID(), childBotId = crypto.randomUUID(), otherBotId = crypto.randomUUID();
  const bots = [botId, childBotId, otherBotId];
  let channelId = "";
  try {
    for (const id of bots) await prisma.bot.create({ data: { id, name: `Bot ${id.slice(0, 4)}`, status: "active", onboardingStatus: "completed", defaultDirectory: "/tmp", conversation: { create: {} } } });
    channelId = (await prisma.channel.create({ data: { kind: "bot_dm", name: "DM", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } })).id;
    const conversation = async (id: string) => (await prisma.conversation.findFirstOrThrow({ where: { botId: id } })).id;
    const runFor = async (id: string, createdAt = new Date()) =>
      prisma.run.create({ data: { botId: id, conversationId: await conversation(id), channelId, origin: "user", userMessageId: crypto.randomUUID(), status: "completed", createdAt } });
    const parentRun = await runFor(botId);
    await prisma.subagent.create({ data: { parentBotId: botId, childBotId, parentRunId: parentRun.id, parentChannelId: channelId, launchCallId: "launch",
      description: "Research", prompt: "Research", subagentType: "executor", status: "completed", outputPath: "/tmp/child.jsonl" } });
    const tool = (runId: string, content: unknown) => prisma.runItem.create({ data: { runId, kind: "tool", status: "completed", title: "CallDynamicTool", content: content as any } });
    // The subagent searched; its result holds the verified place and a route.
    await tool((await runFor(childBotId)).id, { tool: "CallDynamicTool", arguments: {}, result: mcpResult({ results: [{ place: place("google:sub", { rating: 4.8 }) }], route: route("route:sub") }) });
    // An argument the parent wrote must never count as verified data.
    await tool(parentRun.id, { tool: "CallDynamicTool", arguments: { places: [place("google:typed", { rating: 5 })] }, result: mcpResult({ ok: true }) });
    // Old results and other bots' results are out of reach.
    await tool((await runFor(botId, new Date(Date.now() - 2 * 86_400_000))).id, { result: mcpResult({ place: place("google:old") }) });
    await tool((await runFor(otherBotId)).id, { result: mcpResult({ place: place("google:other") }) });

    const presentation = { version: 1, places: ["google:sub"], blocks: [{ type: "place_map", placeIds: ["google:sub"] }] };
    const resolved: any = await resolvePlaceReferences(prisma, botId, presentation, { waitMs: 0 });
    expect(resolved.places[0]).toMatchObject({ id: "google:sub", rating: 4.8 });
    const withRoute: any = await resolvePlaceReferences(prisma, botId, { version: 1, places: [place("google:a"), place("google:b")], blocks: [{ type: "place_map", placeIds: ["google:a", "google:b"], route: "route:sub" }] }, { waitMs: 0 });
    expect(withRoute.blocks[0].route.id).toBe("route:sub");
    for (const id of ["google:typed", "google:old", "google:other"])
      await expect(resolvePlaceReferences(prisma, botId, { version: 1, places: [id], blocks: [{ type: "markdown", text: "x" }] }, { waitMs: 0 })).rejects.toThrow(id);
  } finally {
    await prisma.bot.deleteMany({ where: { id: { in: bots } } });
    if (channelId) await prisma.channel.deleteMany({ where: { id: channelId } });
    await prisma.$disconnect();
  }
});
