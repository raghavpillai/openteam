import { createRoot } from "react-dom/client";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { toggleOwnReaction, ownReactionEmojiSet } from "@openteam/product-core/messages";
import { api, openTeamClient } from "../../src/renderer/client/openteam-api";
import { useOpenTeam } from "../../src/renderer/state/use-openteam";

const errors: string[] = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
window.fetch = async (input) => {
  throw Error(`Unexpected network: ${String(input)}`);
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const message = (id: string) =>
  ({
    id,
    channelId: id,
    sender: "bot",
    senderBotId: "bot",
    content: id,
    sequence: "1",
    createdAt: "2026-11-10T00:00:00Z",
    metadata: { marker: "keep", reactions: [{ emoji: "😂", actorType: "bot", actorId: "peer" }] },
  }) as any;
let server: any[];
let requests: Array<{
  id: string;
  emoji: string;
  resolve: (result: any) => void;
  reject: (cause: Error) => void;
}>;
let state: ReturnType<typeof useOpenTeam>;
let root: ReturnType<typeof createRoot> | null = null;
let bootstraps = 0;
let holdBootstrap = false;
let holdHistory = false;
let historyReads = 0;
let releaseHistory: (() => void) | null = null;
let releaseBootstrap: (() => void) | null = null;
api.bootstrap = async () => {
  bootstraps++;
  const result = {
    cursor: "1",
    workspace: { id: "qa", name: "QA" },
    capabilities: CLIENT_CAPABILITIES,
    runtime: {},
    channels: ["one", "two"].map((id) => ({
      id,
      kind: "bot_dm",
      name: "QA",
      members: [{ botId: "bot", ordinal: 0 }],
      unreadCount: 0,
    })),
    bots: [{ id: "bot", name: "QA", status: "active" }],
    latestMessages: structuredClone(server),
    activeRuns: [],
    channelRounds: [],
    subagents: [],
  } as any;
  if (holdBootstrap) {
    holdBootstrap = false;
    await new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
  }
  return result;
};
api.channelHistory = async (channelId) => {
  historyReads++;
  const result = {
    channelId,
    messages: structuredClone(server.filter((m) => m.channelId === channelId)),
    threadContext: [],
    threadContextTruncated: false,
    beforeSequence: "1",
    hasMore: false,
    revision: "1",
  };
  if (holdHistory) {
    holdHistory = false;
    await new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
  }
  return result;
};
api.channelState = async (channelId) => ({
  channelId,
  revision: "1",
  channelRounds: [],
  runs: [],
  runItems: [],
  subagents: [],
  truncated: { channelRounds: false, runs: false, runItems: false, subagents: false },
});
api.runtime = async () => ({ runtime: {} }) as any;
openTeamClient.listenForEvents = async (_cursor, handlers, signal) => {
  handlers.onOpen?.();
  return new Promise((resolve) =>
    signal?.addEventListener("abort", () => resolve(), { once: true })
  );
};
api.reactToMessage = async (id, emoji) =>
  new Promise((resolve, reject) => requests.push({ id, emoji, resolve, reject }));
function Probe() {
  state = useOpenTeam();
  return <div>Reaction ordering fixture</div>;
}
const own = (id = "one") => [
  ...ownReactionEmojiSet(state.snapshot!.channelMessages.find((m) => m.id === id)!),
];
const click = (emoji: string, id = "one") =>
  state.reactToMessage(id, emoji).catch((cause) => ({ error: String(cause) }));
const ack = async (index: number) => {
  const request = requests[index]!;
  const i = server.findIndex((m) => m.id === request.id);
  server[i] = toggleOwnReaction(server[i], request.emoji);
  request.resolve({ message: structuredClone(server[i]), reacted: true });
  await tick();
};
const reset = async () => {
  root?.unmount();
  server = [message("one"), message("two")];
  requests = [];
  bootstraps = 0;
  holdBootstrap = false;
  releaseBootstrap = null;
  holdHistory = false;
  releaseHistory = null;
  historyReads = 0;
  root = createRoot(document.getElementById("root")!);
  root.render(<Probe />);
  for (let i = 0; i < 50 && (!state?.snapshot || bootstraps === 0); i++) await tick();
  await tick();
};
Object.assign(window, {
  runReactionOrder: async () => {
    const checks: Array<{ name: string; passed: boolean; actual: unknown }> = [];
    const check = (name: string, passed: boolean, actual: unknown) =>
      checks.push({ name, passed, actual });
    await reset();
    const taps = [click("👍"), click("❤️"), click("👍")];
    await tick();
    check(
      "rapid taps coalesce behind one in-flight RPC",
      requests.length === 1,
      requests.map((r) => r.emoji)
    );
    await ack(0);
    check("first acknowledgement keeps latest optimistic selection", own().join() === "👍", own());
    // Drain baseline concurrent calls as well, delivering its obsolete heart last.
    if (requests.length > 2) {
      await ack(2);
      await ack(1);
    } else if (requests.length > 1) await ack(1);
    await Promise.all(taps);
    check(
      "coalesced round trip sends no obsolete heart",
      requests.map((r) => r.emoji).join() === "👍",
      requests.map((r) => r.emoji)
    );
    check("reordered responses cannot restore obsolete emoji", own().join() === "👍", own());

    await reset();
    const first = click("👍"),
      second = click("👍");
    await tick();
    await ack(0);
    check(
      "double tap stays visibly cleared during first acknowledgement",
      own().length === 0,
      own()
    );
    if (requests.length > 1) await ack(1);
    await Promise.all([first, second]);
    check(
      "double tap clears confirmed server selection",
      own().length === 0 && requests.length === 2,
      { own: own(), requests: requests.map((r) => r.emoji) }
    );

    await reset();
    const a = click("👍"),
      b = click("❤️");
    await tick();
    await ack(0);
    check(
      "replacement remains optimistic while second RPC is pending",
      own().join() === "❤️",
      own()
    );
    if (requests.length > 1) await ack(1);
    await Promise.all([a, b]);
    check("replacement finishes as latest emoji", own().join() === "❤️", own());
    const row = state.snapshot!.channelMessages.find((m) => m.id === "one")!;
    check(
      "reaction updates preserve peer and unrelated metadata",
      (row.metadata as any).marker === "keep" &&
        (row.metadata as any).reactions.some((r: any) => r.actorId === "peer"),
      row.metadata
    );

    await reset();
    const refreshTap = click("👍");
    await state.refresh(true);
    await tick();
    check(
      "refresh during pending mutation retains latest desired selection",
      own().join() === "👍",
      own()
    );
    server[0].metadata.marker = "fresh";
    server[0].metadata.reactions.push({ by: "peer", emoji: "🎉" });
    await state.refresh(true);
    await tick();
    const staleAcknowledgement = toggleOwnReaction(message("one"), "👍");
    server[0] = toggleOwnReaction(server[0], "👍");
    requests[0]!.resolve({ message: staleAcknowledgement, reacted: true });
    await refreshTap;
    await tick();
    const fresh = state.snapshot!.channelMessages.find((m) => m.id === "one")!;
    check(
      "stale acknowledgement preserves newer metadata and peer reactions",
      (fresh.metadata as any).marker === "fresh" &&
        (fresh.metadata as any).reactions.some((r: any) => r.by === "peer" && r.emoji === "🎉"),
      fresh.metadata
    );

    await reset();
    const beforeRead = click("👍");
    holdBootstrap = true;
    const staleRead = state.refresh(true);
    await tick();
    await ack(0);
    await beforeRead;
    releaseBootstrap!();
    await staleRead;
    await tick();
    check(
      "bootstrap begun before acknowledgement cannot undo committed selection",
      own().join() === "👍",
      { own: own(), bootstraps }
    );

    await reset();
    const failed = click("👍"),
      discarded = click("❤️");
    await tick();
    requests[0]!.reject(Error("uncertain toggle"));
    if (requests.length > 1) requests[1]!.reject(Error("uncertain queued toggle"));
    await Promise.all([failed, discarded]);
    await tick();
    check(
      "failed mutation discards queued desired state without replay",
      requests.length === 1 && own().length === 0,
      { requests: requests.map((r) => r.emoji), own: own() }
    );
    const deliberateRetry = click("❤️");
    await tick();
    await ack(requests.length - 1);
    await deliberateRetry;
    check("later deliberate tap succeeds after a surfaced failure", own().join() === "❤️", own());

    await reset();
    const one = click("👍"),
      two = click("❤️", "two");
    await tick();
    check(
      "independent messages do not block each other",
      requests.length === 2,
      requests.map((r) => r.id)
    );
    await ack(1);
    requests[0]!.reject(Error("lost acknowledgement"));
    await Promise.all([one, two]);
    await tick();
    check(
      "failed request does not overwrite another message success",
      own("two").join() === "❤️",
      own("two")
    );
    check("uncertain request is not automatically retried", requests.length === 2, requests.length);
    check("failed reaction surfaces an error", Boolean(state.error), state.error);

    await reset();
    holdHistory = true;
    const initialHistory = state.loadChannel("one");
    await tick();
    const historyTap = click("👍");
    await tick();
    await ack(0);
    await historyTap;
    releaseHistory!();
    await initialHistory;
    await tick();
    check(
      "initial history begun before acknowledgement cannot undo committed selection",
      own().join() === "👍",
      { own: own(), historyReads }
    );

    await reset();
    const unloaded = click("👍", "unloaded");
    requests[0]!.resolve({
      message: toggleOwnReaction(message("unloaded"), "👍"),
      messageId: "unloaded",
      emoji: "👍",
      reacted: true,
      removed: false,
      runId: null,
    });
    const unloadedResult = await unloaded;
    check(
      "unloaded message keeps the single-toggle response contract",
      requests.length === 1 && (unloadedResult as any).messageId === "unloaded",
      unloadedResult
    );
    const unloadedFailure = click("❤️", "unloaded");
    requests[1]!.reject(Error("unloaded reaction failure"));
    await unloadedFailure;
    await tick();
    check(
      "unloaded message failures still surface an error",
      state.error === "unloaded reaction failure",
      state.error
    );

    await reset();
    const mismatch = click("👍"),
      mismatchQueue = click("❤️");
    await tick();
    requests[0]!.resolve({ message: message("one"), reacted: true });
    if (requests.length > 1) requests[1]!.resolve({ message: message("one"), reacted: true });
    await Promise.all([mismatch, mismatchQueue]);
    await tick();
    check(
      "unexpected acknowledgement stops instead of retrying toggles",
      requests.length === 1 && Boolean(state.error) && own().length === 0,
      { requests: requests.length, error: state.error, own: own() }
    );

    await reset();
    const pending = click("👍"),
      queued = click("❤️");
    await tick();
    root!.unmount();
    root = null;
    await ack(0);
    // Baseline issued both already; complete them so the fixture leaves no promises hanging.
    if (requests.length > 1) await ack(1);
    await Promise.all([pending, queued]);
    check(
      "unmount prevents dispatching queued mutations",
      requests.length === 1,
      requests.map((r) => r.emoji)
    );
    check("browser fixture has no uncaught errors", errors.length === 0, errors);
    return { checks, passed: checks.filter((c) => c.passed).length, total: checks.length };
  },
});
