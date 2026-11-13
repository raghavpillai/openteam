import type { BotView, ClientBootstrapView } from "@openteam/contracts";
import { readThemePreference, THEME_CHANGE_EVENT } from "./theme";
import { api } from "../client/openteam-api";
import { API_BASE } from "../client/http";
import { authHeaders, AUTH_CREDENTIALS_CHANGED_EVENT, getScreenBotAccountScope, subscribeAuthSnapshot } from "../client/auth";
import { desktopDurableSendController, discardDesktopDeliveryStages } from "./durable-sends";

type Bridge = NonNullable<NonNullable<Window["openteam"]>["screenbot"]>;

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
      (latest.get(right.dmChannelId) ?? 0) - (latest.get(left.dmChannelId) ?? 0) || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
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
 * The main window's half of ScreenBots: it keeps the floating composer's Bot list current and
 * delivers what it captures. Delivery uses the chat composer's durable path, so a ScreenBot
 * shows up in the conversation at once and survives going offline like any other message.
 * Loaded after the workspace, so it costs signed-in startup nothing.
 */
export function startScreenBotBridge(): () => void {
  const bridge: Bridge | undefined = window.openteam?.screenbot;
  if (!bridge) return () => {};
  type Session = { scope: string; bots: BotView[]; refreshedAt: number; refreshing: Promise<void> | null; published: ReturnType<typeof rosterFor> | null };
  let session: Session | null = null;
  let stopped = false;
  const current = (owner: Session) => !stopped && session === owner && getScreenBotAccountScope() === owner.scope;
  const requireCurrent = (owner: Session | null, scope: string): Session => {
    if (!owner || owner.scope !== scope || !current(owner)) throw new Error("ScreenBot account changed. Take the screenshot again.");
    return owner;
  };
  const publish = (owner: Session, roster: ReturnType<typeof rosterFor>) => {
    if (!current(owner)) return;
    owner.published = roster;
    bridge.publishRoster({ ...roster, accountScope: owner.scope });
  };
  const onTheme = () => {
    if (session?.published) publish(session, { ...session.published, theme: readThemePreference() });
  };
  const reset = () => {
    session = null;
    avatarCache.clear();
    bridge.publishRoster({ accountScope: null, bots: [], dictation: false });
  };
  const refresh = (owner = session): Promise<void> => {
    if (!owner || !current(owner)) return Promise.resolve();
    owner.refreshing ??= (async () => {
      try {
        const snapshot = await api.bootstrap();
        if (!current(owner)) return;
        owner.refreshedAt = Date.now();
        const next = sendableBots(snapshot);
        const dictation = snapshot.runtime.transcription === "configured";
        owner.bots = next;
        publish(owner, rosterFor(next, dictation));
        if (next.some((bot) => bot.hasAvatar)) {
          const avatars = await Promise.all(next.map(avatarDataUrl));
          if (current(owner) && owner.bots === next) publish(owner, rosterFor(next, dictation, avatars));
        }
      } catch {
        // Offline within this account: retain its last list. Auth invalidation resets it.
      } finally {
        owner.refreshing = null;
      }
    })();
    return owner.refreshing;
  };
  const reconcileAuth = () => {
    const scope = getScreenBotAccountScope();
    if (scope === session?.scope) return;
    reset();
    if (scope && !stopped) {
      session = { scope, bots: [], refreshedAt: 0, refreshing: null, published: null };
      void refresh(session);
    }
  };
  window.addEventListener(THEME_CHANGE_EVENT, onTheme);
  window.addEventListener(AUTH_CREDENTIALS_CHANGED_EVENT, reset);
  const stopAuth = subscribeAuthSnapshot(reconcileAuth);
  const stopRequests = bridge.onRosterRequest(() => {
    const owner = session;
    if (!owner || !current(owner)) return;
    if (owner.published) publish(owner, owner.published);
    if (Date.now() - owner.refreshedAt > 30_000) void refresh(owner);
  });
  const stopDelivery = bridge.onDeliver(async (request) => {
    const owner = requireCurrent(session, request.accountScope);
    let bot = owner.bots.find((candidate) => candidate.id === request.botId);
    if (!bot) {
      await refresh(owner);
      requireCurrent(owner, request.accountScope);
      bot = owner.bots.find((candidate) => candidate.id === request.botId);
    }
    if (!bot) throw new Error("That Bot is no longer available.");
    const { staged } = request;
    // Capture the current account's controller before its first asynchronous operation.
    const controller = desktopDurableSendController();
    try {
      await controller.enqueue({
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
      requireCurrent(owner, request.accountScope);
    } catch (error) {
      if (current(owner) && error instanceof Error && /already in use/.test(error.message)) {
        await discardDesktopDeliveryStages([{ ...staged, kind: "image" }]).catch(() => undefined);
        requireCurrent(owner, request.accountScope);
        return;
      }
      throw error;
    }
  });
  const stopTranscribe = bridge.onTranscribe(async ({ accountScope, audio, mimeType }) => {
    const owner = requireCurrent(session, accountScope);
    const result = await api.transcribeAudio(new Blob([audio as Uint8Array<ArrayBuffer>], { type: mimeType }));
    requireCurrent(owner, accountScope);
    return result.text;
  });
  reconcileAuth();
  return () => {
    stopped = true;
    reset();
    window.removeEventListener(THEME_CHANGE_EVENT, onTheme);
    window.removeEventListener(AUTH_CREDENTIALS_CHANGED_EVENT, reset);
    stopAuth();
    stopRequests();
    stopDelivery();
    stopTranscribe();
  };
}
