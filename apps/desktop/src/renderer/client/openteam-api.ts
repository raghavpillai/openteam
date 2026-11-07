import { createOpenTeamClient } from "@openteam/client-core";
import { authHeaders, getDesktopMachineId } from "./auth";
import { API_BASE, desktopTransportOptions } from "./http";
import { request } from "./http";
import type {
  VoiceSessionCreateInput,
  VoiceSessionTicketView,
  VoiceSessionView,
  VoiceSettingsInput,
  VoiceSettingsView,
} from "@openteam/contracts/voice";

const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Portable product API plus the desktop lifecycle adapter below. */
export const openTeamClient = createOpenTeamClient({
  ...desktopTransportOptions,
  createId: () => crypto.randomUUID(),
  timeZone: localTimeZone,
  sourceMachineId: getDesktopMachineId,
});

export type { ChannelClientState, ClientBootstrapView } from "@openteam/contracts";

export const api = {
  ...openTeamClient,
  authenticatePlugin: (connectionId: string, force = false) =>
    window.openteam?.pluginOAuth
      ? window.openteam.pluginOAuth.start(connectionId, force)
      : openTeamClient.authenticatePlugin(connectionId, force),
  cancelPluginAuthentication: async (connectionId: string, state: string) => {
    if (await window.openteam?.pluginOAuth?.cancel(connectionId, state)) return { cancelled: true };
    // A server callback, or an attempt owned by a different desktop, can still be cancelled.
    const settings = await openTeamClient.pluginConnectionStatuses([connectionId]);
    const authorizationUrl = settings.connections[0]?.authorizationUrl;
    const redirect = authorizationUrl ? new URL(authorizationUrl).searchParams.get("redirect_uri") : null;
    const local = redirect?.startsWith("http://127.0.0.1:") && new URL(redirect).pathname === "/callback";
    return openTeamClient.cancelPluginAuthentication(connectionId, state, local ? redirect! : undefined);
  },
  sendMessage: openTeamClient.sendDirectMessage,
  voice: {
    createSession: (input: VoiceSessionCreateInput) => request<VoiceSessionTicketView>("/api/voice/sessions", { method: "POST", body: JSON.stringify(input) }),
    getSession: (sessionId: string) => request<{ session: VoiceSessionView; turns: unknown[] }>(`/api/voice/sessions/${encodeURIComponent(sessionId)}`),
    reconnectTicket: (sessionId: string) => request<VoiceSessionTicketView>(`/api/voice/sessions/${encodeURIComponent(sessionId)}/tickets`, { method: "POST" }),
    endSession: (sessionId: string) => request<{ ok: true }>(`/api/voice/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
    settings: () => request<VoiceSettingsView>("/api/server-settings/voice"),
    updateSettings: (input: VoiceSettingsInput) =>
      request<VoiceSettingsView>("/api/server-settings/voice", {
        method: "PUT",
        body: JSON.stringify(input),
      }),
  },
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
