import { describe, expect, test } from "bun:test";
import type { ChannelMessageView, ClientBootstrapView } from "@openteam/contracts";
import type { LoadedChannelHistory } from "@openteam/product-core/history";
import {
  backgroundHistoryNeed,
  bootstrapSnapshot,
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
    const transcript = [message("loaded", 1), message("loaded", 2)];
    const newest = message("loaded", 5);
    const { snapshot, detachedMessageIds } = project(
      [newest, message("preview", 3)],
      history(transcript)
    );

    // Previews and unread state still see the newest message.
    expect(snapshot.channelMessages.map(({ id }) => id)).toEqual([
      "loaded-m1",
      "loaded-m2",
      "loaded-m5",
      "preview-m3",
    ]);
    // Messages 3 and 4 are unknown, so the transcript must not show 5 yet.
    expect([...detachedMessageIds]).toEqual(["loaded-m5"]);
  });

  test("keeps a newest message the loaded transcript already contains", () => {
    const newest = message("loaded", 2);
    const { detachedMessageIds } = project(
      [{ ...newest, content: "edited" }],
      history([message("loaded", 1), newest])
    );
    expect(detachedMessageIds.size).toBe(0);
  });

  test("never shows a bootstrap preview row before the first history page", () => {
    const { detachedMessageIds } = project([message("loaded", 4)], history([], 0));
    expect([...detachedMessageIds]).toEqual(["loaded-m4"]);
  });

  test("treats an unloaded channel's newest message as its preview", () => {
    const { snapshot, detachedMessageIds } = project([message("preview", 3)], history([]));
    expect(snapshot.channelMessages.map(({ id }) => id)).toContain("preview-m3");
    expect(detachedMessageIds.has("preview-m3")).toBe(false);
  });
});

describe("background history", () => {
  const withUnread = (
    latest: ChannelMessageView[],
    unread: Record<string, number>,
    hidden = ""
  ) => {
    const base = bootstrap(latest);
    return {
      ...base,
      channels: base.channels.map((candidate) => ({
        ...candidate,
        unreadCount: unread[candidate.id] ?? 0,
        hiddenFromSidebar: candidate.id === hidden,
      })),
    } as unknown as ClientBootstrapView;
  };

  test("reads a loaded chat in the background when its transcript withholds the newest message", () => {
    const loaded = history([message("loaded", 1), message("loaded", 2)]);
    const latest = [message("loaded", 5)];
    const { detachedMessageIds } = project(latest, loaded);
    const need = (activeChannelId: string | undefined) =>
      backgroundHistoryNeed({
        bootstrap: withUnread(latest, {}),
        channelId: "loaded",
        activeChannelId,
        history: loaded,
        detachedMessageIds,
      });
    expect(need("preview")).toBe("refresh");
    // The open chat reads its own history after every event.
    expect(need("loaded")).toBeNull();
  });

  test("leaves a loaded chat alone once its transcript has the newest message", () => {
    const loaded = history([message("loaded", 1), message("loaded", 2)]);
    const latest = [message("loaded", 2)];
    const { detachedMessageIds } = project(latest, loaded);
    expect(
      backgroundHistoryNeed({
        bootstrap: withUnread(latest, {}),
        channelId: "loaded",
        activeChannelId: "preview",
        history: loaded,
        detachedMessageIds,
      })
    ).toBeNull();
  });

  test("loads a never-opened chat only when it has unread messages", () => {
    const latest = [message("preview", 3)];
    const need = (unread: number, hidden = "") =>
      backgroundHistoryNeed({
        bootstrap: withUnread(latest, { preview: unread }, hidden),
        channelId: "preview",
        activeChannelId: "loaded",
        history: undefined,
        detachedMessageIds: new Set(),
      });
    expect(need(1)).toBe("load");
    expect(need(0)).toBeNull();
    expect(need(1, "preview")).toBeNull();
  });

  test("waits for a chat whose first page is still loading", () => {
    const latest = [message("loaded", 4)];
    const loading = history([], 0);
    const { detachedMessageIds } = project(latest, loading);
    expect(
      backgroundHistoryNeed({
        bootstrap: withUnread(latest, { loaded: 1 }),
        channelId: "loaded",
        activeChannelId: "preview",
        history: loading,
        detachedMessageIds,
      })
    ).toBeNull();
  });
});
