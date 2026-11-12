import type { BotView, ClientBootstrapView } from "@openteam/contracts";
import { readThemePreference, THEME_CHANGE_EVENT } from "./theme";
import { api } from "../client/openteam-api";
import { API_BASE } from "../client/http";
import { authHeaders } from "../client/auth";
import { desktopDurableSendController, discardDesktopDeliveryStages } from "./durable-sends";

type Bridge = NonNullable<NonNullable<Window["openteam"]>["appshot"]>;

const avatarCache = new Map<string, Promise<string | undefined>>();

/** Custom avatars are authenticated resources; the overlay gets a small data URL instead. */
const avatarDataUrl = (bot: BotView): Promise<string | undefined> => {
  if (!bot.hasAvatar) return Promise.resolve(undefined);
  const key = `${bot.id}:${bot.updatedAt}`;
  const cached = avatarCache.get(key);
  if (cached) return cached;
  const result = (async () => {
    try {
      const response = await fetch(
        `${API_BASE}/api/v0/bots/${encodeURIComponent(bot.id)}/avatar?v=${encodeURIComponent(bot.updatedAt)}`,
        { headers: authHeaders() }
      );
      if (!response.ok) return undefined;
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 96;
      const context = canvas.getContext("2d");
      if (!context) return undefined;
      const side = Math.min(bitmap.width, bitmap.height);
      context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 96, 96);
      bitmap.close();
      return canvas.toDataURL("image/png");
    } catch {
      return undefined;
    }
  })();
  avatarCache.set(key, result);
  return result;
};

/** Bots that can take a message, most recently active first. */
const sendableBots = (snapshot: ClientBootstrapView): BotView[] => {
  const latest = new Map<string, number>();
  for (const message of snapshot.latestMessages) {
    const time = Date.parse(message.createdAt);
    if (Number.isFinite(time) && time > (latest.get(message.channelId) ?? 0)) latest.set(message.channelId, time);
  }
  return snapshot.bots
    .filter((bot) => bot.status !== "archived" && bot.status !== "failed")
    .sort((left, right) =>
      (latest.get(right.dmChannelId) ?? 0) - (latest.get(left.dmChannelId) ?? 0) || left.name.localeCompare(right.name)
    );
};

const rosterFor = (bots: BotView[], dictation: boolean, avatars: Array<string | undefined> = []) => ({
  dictation,
  // The overlay keeps its own storage, so it learns the appearance setting from here.
  theme: readThemePreference(),
  bots: bots.map((bot, index) => ({
    id: bot.id,
    name: bot.name,
    title: bot.title,
    color: bot.color,
    icon: bot.icon,
    channelId: bot.dmChannelId,
    ...(avatars[index] ? { avatarDataUrl: avatars[index] } : {}),
  })),
});

/**
 * The main window's half of appshots: it keeps the floating composer's Bot list current and
 * delivers what it captures. Delivery uses the chat composer's durable path, so an appshot
 * shows up in the conversation at once and survives going offline like any other message.
 * Loaded after the workspace, so it costs signed-in startup nothing.
 */
export function startAppshotBridge(): () => void {
  const bridge: Bridge | undefined = window.openteam?.appshot;
  if (!bridge) return () => {};
  let bots: BotView[] = [];
  let refreshing: Promise<void> | null = null;
  let stopped = false;

  let published: ReturnType<typeof rosterFor> | null = null;
  const publish = (roster: ReturnType<typeof rosterFor>) => {
    published = roster;
    bridge.publishRoster(roster);
  };
  // A new appearance setting reaches the overlay with the same list.
  const onTheme = () => {
    if (published) publish({ ...published, theme: readThemePreference() });
  };
  window.addEventListener(THEME_CHANGE_EVENT, onTheme);

  let refreshedAt = 0;
  /** A full refresh at most every 30 s: each appshot asks, and spamming it must stay cheap. */
  const refreshIfStale = () => {
    if (Date.now() - refreshedAt > 30_000) void refresh();
  };
  const refresh = () => {
    refreshing ??= (async () => {
      try {
        const snapshot = await api.bootstrap();
        refreshedAt = Date.now();
        const next = sendableBots(snapshot);
        const dictation = snapshot.runtime.transcription === "configured";
        if (stopped) return;
        bots = next;
        publish(rosterFor(next, dictation));
        if (next.some((bot) => bot.hasAvatar)) {
          const avatars = await Promise.all(next.map(avatarDataUrl));
          if (!stopped && bots === next) publish(rosterFor(next, dictation, avatars));
        }
      } catch {
        // Signed out or offline: the overlay keeps the last list it was given.
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };

  // Main forgets the list when this page goes away (reload, crash), so an ask is answered
  // with the cached list at once; a fresh fetch follows only when it's stale.
  const stopRequests = bridge.onRosterRequest(() => {
    if (published) bridge.publishRoster(published);
    refreshIfStale();
  });
  const stopDelivery = bridge.onDeliver(async (request) => {
    let bot = bots.find((candidate) => candidate.id === request.botId);
    if (!bot) {
      await refresh();
      bot = bots.find((candidate) => candidate.id === request.botId);
    }
    if (!bot) throw new Error("That Bot is no longer available.");
    const { staged } = request;
    try {
      await desktopDurableSendController().enqueue({
        // One nonce per shot: a retry after a timeout finds it already queued.
        nonce: request.nonce,
        target: { channelId: bot.dmChannelId, conversationId: bot.conversationId },
        payload: {
          content: request.content,
          attachments: [],
          stagedAttachments: [{
            ...staged,
            kind: "image",
            position: 0,
            previewUri: `openteam-staged://file/${staged.stagingId}?mime=${encodeURIComponent(staged.mimeType)}`,
          }],
        },
      });
    } catch (error) {
      // Already queued by an earlier attempt: this attempt's staged copy is unused.
      if (error instanceof Error && /already in use/.test(error.message)) {
        await discardDesktopDeliveryStages([{ ...staged, kind: "image" }]).catch(() => undefined);
        return;
      }
      throw error;
    }
  });
  const stopTranscribe = bridge.onTranscribe(async ({ audio, mimeType }) =>
    (await api.transcribeAudio(new Blob([audio as Uint8Array<ArrayBuffer>], { type: mimeType }))).text
  );
  void refresh();
  return () => {
    stopped = true;
    // Signed out (or the workspace unmounted): the overlay must not offer this account's Bots.
    window.removeEventListener(THEME_CHANGE_EVENT, onTheme);
    bridge.publishRoster({ bots: [], dictation: false });
    stopRequests();
    stopDelivery();
    stopTranscribe();
  };
}
