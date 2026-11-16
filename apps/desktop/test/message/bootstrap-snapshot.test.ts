import { describe, expect, test } from "bun:test";
import type { ChannelMessageView, ClientBootstrapView } from "@openteam/contracts";
import type { LoadedChannelHistory } from "@openteam/product-core/history";
import type { ChannelClientState } from "../../src/renderer/client/openteam-api";
import {
  backgroundHistoryNeed,
  bootstrapSnapshot,
  openHistoryNeedsRead,
} from "../../src/renderer/lib/bootstrap-snapshot";
import { emptyChannelMessageWindow } from "../../src/renderer/lib/message-history-window";

const channel = (id: string) => ({ id, kind: "bot_dm", name: id, members: [] });

const message = (channelId: string, sequence: number): ChannelMessageView => ({
  id: `${channelId}-m${sequence}`,
  clientId: null,
  sequence: String(sequence),
  channelId,
  sender: "agent",
  senderBotId: "bot-1",
  sourceRunId: null,
  content: `message ${sequence}`,
  metadata: {},
  createdAt: new Date(Date.UTC(2026, 9, 16, 12, 0, sequence)).toISOString(),
});

const bootstrap = (latestMessages: ChannelMessageView[]): ClientBootstrapView =>
  ({
    cursor: "100",
    workspace: {},
    bots: [],
    channels: [channel("loaded"), channel("preview")],
    latestMessages,
    activeRuns: [],
    channelRounds: [],
    subagents: [],
    runtime: {},
    capabilities: {},
  }) as unknown as ClientBootstrapView;

const history = (messages: ChannelMessageView[], loadedAt = 1): LoadedChannelHistory => ({
  messages,
  threadContext: [],
  searchContext: [],
  searchThreadContext: [],
  threadContextTruncated: false,
  searchThreadContextTruncated: false,
  beforeSequence: null,
  hasMore: false,
  loading: loadedAt === 0,
  loadedAt,
});

const project = (latest: ChannelMessageView[], loaded: LoadedChannelHistory) =>
  bootstrapSnapshot(
    bootstrap(latest),
    new Map([["loaded", loaded]]),
    new Map([["loaded", emptyChannelMessageWindow()]]),
    new Map()
  );

describe("bootstrap snapshot", () => {
  test("withholds a newer bootstrap message from a loaded transcript until history has it", () => {
    const { snapshot, detachedMessageIds } = project([message("loaded", 5), message("preview", 3)], history([message("loaded", 1), message("loaded", 2)]));
    // Previews and unread state still see the newest message.
    expect(snapshot.channelMessages.map(({ id }) => id)).toEqual(["loaded-m1", "loaded-m2", "loaded-m5", "preview-m3"]);
    // Messages 3 and 4 are unknown, so the transcript must not show 5 yet; an unloaded chat's newest is its preview.
    expect([...detachedMessageIds]).toEqual(["loaded-m5"]);
  });

  test("keeps a newest message the transcript already has, and shows no preview row before the first page", () => {
    const newest = message("loaded", 2);
    expect(project([{ ...newest, content: "edited" }], history([message("loaded", 1), newest])).detachedMessageIds.size).toBe(0);
    expect([...project([message("loaded", 4)], history([], 0)).detachedMessageIds]).toEqual(["loaded-m4"]);
  });
});

describe("background history", () => {
  const need = (latest: ChannelMessageView[], channelId: string, loaded: LoadedChannelHistory | undefined, options: { active?: string; unread?: number; hidden?: boolean } = {}) => {
    const base = bootstrap(latest);
    return backgroundHistoryNeed({
      bootstrap: {
        ...base,
        channels: base.channels.map((candidate) => ({
          ...candidate,
          unreadCount: candidate.id === channelId ? options.unread ?? 0 : 0,
          hiddenFromSidebar: candidate.id === channelId && !!options.hidden,
        })),
      } as unknown as ClientBootstrapView,
      channelId,
      activeChannelId: options.active ?? (channelId === "loaded" ? "preview" : "loaded"),
      history: loaded,
      detachedMessageIds: loaded ? project(latest, loaded).detachedMessageIds : new Set(),
    });
  };

  test("refreshes a background chat only while its transcript withholds the newest message", () => {
    const loaded = history([message("loaded", 1), message("loaded", 2)]);
    expect(need([message("loaded", 5)], "loaded", loaded)).toBe("refresh");
    // The open chat reads its own history after every event.
    expect(need([message("loaded", 5)], "loaded", loaded, { active: "loaded" })).toBeNull();
    expect(need([message("loaded", 2)], "loaded", loaded)).toBeNull();
    // A first page still loading is left to finish.
    expect(need([message("loaded", 4)], "loaded", history([], 0), { unread: 1 })).toBeNull();
  });

  test("loads a never-opened, visible chat only when it has unread messages", () => {
    const latest = [message("preview", 3)];
    expect(need(latest, "preview", undefined, { unread: 1 })).toBe("load");
    expect(need(latest, "preview", undefined, { unread: 0 })).toBeNull();
    expect(need(latest, "preview", undefined, { unread: 1, hidden: true })).toBeNull();
  });
});

test("an open chat reuses a recent page only if it holds the newest message and run state caught up", () => {
  const now = 10_000;
  const need = (transcript: ChannelMessageView[], revision: string, loadedAt = now - 20) => {
    const latest = [message("loaded", 5)];
    const loaded = history(transcript, loadedAt);
    return openHistoryNeedsRead({
      bootstrap: bootstrap(latest),
      channelId: "loaded",
      history: loaded,
      state: { channelId: "loaded", revision } as unknown as ChannelClientState,
      detachedMessageIds: project(latest, loaded).detachedMessageIds,
      now,
    });
  };
  const complete = [message("loaded", 4), message("loaded", 5)];
  expect(need(complete, "100")).toBe(false);
  // History and run state are separate reads: a reply landing between them is in the state's
  // revision but not on the page, so bootstrap would notify while the transcript withholds it.
  expect(need([message("loaded", 3), message("loaded", 4)], "100")).toBe(true);
  expect(need(complete, "99")).toBe(true);
  expect(need(complete, "100", now - 250)).toBe(true);
});
