import { createOpenBotClient } from "@openbot/client-core";
import { authHeaders } from "./auth";
import { API_BASE, desktopTransportOptions } from "./http";

const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Portable product API plus the desktop lifecycle adapter below. */
export const openBotClient = createOpenBotClient({
  ...desktopTransportOptions,
  createId: () => crypto.randomUUID(),
  timeZone: localTimeZone,
});

export type { ChannelClientState, ClientBootstrapView } from "@openbot/contracts";

export const api = {
  ...openBotClient,
  sendMessage: openBotClient.sendDirectMessage,
  screenTakeover: openBotClient.setScreenTakeover,
  /** Best-effort unload path; keepalive is a browser lifecycle concern. */
  releaseScreenTakeover: (botId: string) => {
    void fetch(`${API_BASE}/api/v0/bots/${encodeURIComponent(botId)}/screen/takeover`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ active: false }),
      keepalive: true,
    }).catch(() => undefined);
  },
};
