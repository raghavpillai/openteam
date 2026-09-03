import { createOpenTeamClient } from "@openteam/client-core";
import { authHeaders } from "./auth";
import { API_BASE, desktopTransportOptions } from "./http";

const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Portable product API plus the desktop lifecycle adapter below. */
export const openTeamClient = createOpenTeamClient({
  ...desktopTransportOptions,
  createId: () => crypto.randomUUID(),
  timeZone: localTimeZone,
});

export type { ChannelClientState, ClientBootstrapView } from "@openteam/contracts";

export const api = {
  ...openTeamClient,
  sendMessage: openTeamClient.sendDirectMessage,
  screenTakeover: openTeamClient.setScreenTakeover,
  /** Best-effort unload path; keepalive is a browser lifecycle concern. */
  releaseScreenTakeover: (botId: string) => {
    void fetch(`${API_BASE}/api/v0/bots/${encodeURIComponent(botId)}/screen/takeover`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ active: false }),
      keepalive: true,
    }).catch(() => undefined);
  },
  /** Best-effort navigation/app-close path for an active secure handoff. */
  releaseComputerHandoff: (messageId: string) => {
    void fetch(
      `${API_BASE}/api/v0/channel-messages/${encodeURIComponent(messageId)}/computer-handoff`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ action: "dismiss", clientId: crypto.randomUUID() }),
        keepalive: true,
      }
    ).catch(() => undefined);
  },
};
