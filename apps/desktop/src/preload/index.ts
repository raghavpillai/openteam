import { contextBridge, ipcRenderer } from "electron";
import { parseNotificationTarget } from "../main/notifications";
import type { DesktopNotificationTarget } from "@openteam/contracts/notification-content";
import type { ApplicationMenuAction } from "../main/application-menu";


/** What the screenbot overlay shows when the chat window couldn't do what it asked. Network
 * failures surface from fetch as a bare "Failed to fetch"; say what that means instead. */
/** Subscribes to a channel's values; returns the unsubscribe. */
const listen = (channel: string, callback: (value: unknown) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
};

const screenBotError = (error: unknown, fallback: string) => {
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) return "Couldn’t reach OpenTeam. Check your connection and try again.";
  return error instanceof Error && error.message ? error.message : fallback;
};

const appVersionArgument = process.argv.find((argument) =>
  argument.startsWith("--openteam-app-version=")
);
const appVersion = (() => {
  if (!appVersionArgument) return "0.0.0";
  try {
    return decodeURIComponent(appVersionArgument.slice("--openteam-app-version=".length));
  } catch {
    return "0.0.0";
  }
})();

type AuthTokenStorageResult = {
  token: string | null;
  persistence: "disk";
  backend: string;
};

const authTokenStorageResult = (value: unknown): AuthTokenStorageResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Authentication storage returned an invalid response");
  }
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.token !== null && typeof candidate.token !== "string") ||
    candidate.persistence !== "disk" ||
    typeof candidate.backend !== "string"
  ) {
    throw new Error("Authentication storage returned an invalid response");
  }
  return candidate as AuthTokenStorageResult;
};

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};



const downloadRequests = (value: unknown) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) {
    throw new Error("Download request is invalid");
  }
  for (const candidate of value) {
    const input = record(candidate, "Download item");
    if (
      typeof input.fileName !== "string" ||
      !input.fileName.trim() ||
      input.fileName.length > 512 ||
      typeof input.url !== "string" ||
      input.url.length > 2_000
    ) {
      throw new Error("Download item is invalid");
    }
  }
  return value;
};

const stagingId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{8,120}$/.test(value)) {
    throw new Error("Delivery staging ID is invalid");
  }
  return value;
};

const deliveryStageRequest = (value: { stagingId: string; bytes: ArrayBuffer }) => {
  stagingId(value.stagingId);
  if (!(value.bytes instanceof ArrayBuffer) || value.bytes.byteLength === 0) {
    throw new Error("Delivery staging bytes are invalid");
  }
  return value;
};

const deliveryStageIds = (value: string[]) => {
  if (value.length > 24) throw new Error("Too many delivery staging IDs");
  return value.map(stagingId);
};

const deliveryJournalScope = (value: string): string => {
  if (typeof value !== "string" || !value || value.length > 2_048) {
    throw new Error("Delivery journal scope is invalid");
  }
  return value;
};

const deliveryJournal = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Delivery journal is invalid");
  }
  return value;
};

interface ScreenBotDelivery {
  accountScope: string;
  botId: string;
  content: string;
  nonce: string;
  staged: { stagingId: string; fileName: string; mimeType: string; byteSize: number; width: number; height: number };
}

const notificationSnapshot = (value: unknown) => {
  const input = record(value, "Notification snapshot");
  if (!Array.isArray(input.channels) || input.channels.length > 10_000) {
    throw new Error("Notification snapshot is invalid");
  }
  return value;
};

contextBridge.exposeInMainWorld("openteam", {
  platform: process.platform,
  clipboard: {
    readText: (): Promise<string> => ipcRenderer.invoke("openteam:computer-clipboard-read"),
    writeText: (text: string): Promise<void> => ipcRenderer.invoke("openteam:computer-clipboard-write", text),
    setComputerActive: (active: boolean) => {
      if (typeof active === "boolean") ipcRenderer.send("openteam:computer-clipboard-active", active);
    },
    onComputerAction: (callback: (action: "copy" | "cut" | "paste") => void) => {
      const listener = (_event: Electron.IpcRendererEvent, action: unknown) => {
        if (action === "copy" || action === "cut" || action === "paste") callback(action);
      };
      ipcRenderer.on("openteam:computer-clipboard", listener);
      return () => ipcRenderer.removeListener("openteam:computer-clipboard", listener);
    },
  },
  onMenuAction: (callback: (action: ApplicationMenuAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (action === "about" || action === "updates" || action === "settings") callback(action);
    };
    ipcRenderer.on("openteam:app-menu", listener);
    return () => ipcRenderer.removeListener("openteam:app-menu", listener);
  },
  visibility: {
    subscribeActivity: (callback: (active: boolean) => void) => {
      let subscribed = true;
      let receivedEvent = false;
      const listener = (_event: Electron.IpcRendererEvent, active: unknown) => {
        if (typeof active !== "boolean") return;
        receivedEvent = true;
        if (subscribed) callback(active);
      };
      ipcRenderer.on("openteam:window-activity-changed", listener);
      void ipcRenderer.invoke("openteam:window-activity").then((active) => {
        if (subscribed && !receivedEvent && typeof active === "boolean") callback(active);
      }).catch(() => { /* Browser focus remains the fallback during shutdown. */ });
      return () => { subscribed = false; ipcRenderer.removeListener("openteam:window-activity-changed", listener); };
    },
    subscribe: (callback: (visible: boolean) => void) => {
      let active = true;
      let receivedEvent = false;
      const listener = (_event: Electron.IpcRendererEvent, visible: unknown) => {
        if (typeof visible !== "boolean") return;
        receivedEvent = true;
        if (active) callback(visible);
      };
      ipcRenderer.on("openteam:window-visibility-changed", listener);
      void ipcRenderer.invoke("openteam:window-visibility").then((visible) => {
        if (active && !receivedEvent && typeof visible === "boolean") callback(visible);
      }).catch(() => { /* Browser visibility remains the fallback during shutdown. */ });
      return () => { active = false; ipcRenderer.removeListener("openteam:window-visibility-changed", listener); };
    },
  },
  auth: {
    connectMachine: (serverUrl: string) => ipcRenderer.invoke("openteam:machine:connect", serverUrl),
    machineStatus: () => ipcRenderer.invoke("openteam:machine:status"),
    signIn: (serverUrl: string, username: string, password: string) =>
      ipcRenderer.invoke("openteam:auth:sign-in", serverUrl, username, password),
    signOut: (serverUrl: string, token: string) =>
      ipcRenderer.invoke("openteam:auth:sign-out", serverUrl, token),
    readToken: async () =>
      authTokenStorageResult(await ipcRenderer.invoke("openteam:auth-token:read")),
    writeToken: async (token: string) => {
      if (typeof token !== "string" || !token.trim() || token.length > 16 * 1024) {
        throw new Error("Authentication token is invalid");
      }
      return authTokenStorageResult(await ipcRenderer.invoke("openteam:auth-token:write", token));
    },
    clearToken: async () =>
      authTokenStorageResult(await ipcRenderer.invoke("openteam:auth-token:clear")),
  },
  pluginOAuth: {
    start: (connectionId: string, force = false) => ipcRenderer.invoke("openteam:plugin-oauth:start", connectionId, force),
    cancel: (connectionId: string, state: string) => ipcRenderer.invoke("openteam:plugin-oauth:cancel", connectionId, state),
    close: () => ipcRenderer.invoke("openteam:plugin-oauth:close"),
    onResult: (callback: (result: { connectionId: string; status: "ready" | "cancelled" | "error"; message?: string }) => void) => {
      return listen("openteam:plugin-oauth:result", (result) => callback(result as Parameters<typeof callback>[0]));
    },
  },
  localServer: {
    detect: () => ipcRenderer.invoke("openteam:local-server:detect"),
  },
  providerSignIn: {
    capture: (authorizationUrl: string, redirectUri: string) =>
      ipcRenderer.invoke("openteam:provider-sign-in:capture", authorizationUrl, redirectUri),
    cancel: () => ipcRenderer.invoke("openteam:provider-sign-in:cancel"),
  },
  computer: {
    network: () => ipcRenderer.invoke("openteam:network:get"),
    shareNetwork: (enabled: boolean) => ipcRenderer.invoke("openteam:network:share", enabled),
    get: () => ipcRenderer.invoke("openteam:computer:get"),
    update: (request: { machineLabel?: string; messagesEnabled?: boolean }) => ipcRenderer.invoke("openteam:computer:update", request),
    messagesPermissions: (request?: "fullDiskAccess" | "automation" | "contacts") => ipcRenderer.invoke("openteam:computer:messages-permissions", request ?? null),
    messagesIcon: (): Promise<string | null> => ipcRenderer.invoke("openteam:computer:messages-icon"),
    onMessagesGrantsNeeded: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on("openteam:messages-grants-needed", handler);
      return () => { ipcRenderer.removeListener("openteam:messages-grants-needed", handler); };
    },
  },
  files: {
    downloadAll: (files: Array<{ fileName: string; url: string }>) =>
      ipcRenderer.invoke("openteam:files:download-all", downloadRequests(files)),
    stageDelivery: (request: { stagingId: string; bytes: ArrayBuffer }) =>
      ipcRenderer.invoke("openteam:files:stage-delivery", deliveryStageRequest(request)),
    readDeliveryStage: (id: string) =>
      ipcRenderer.invoke(
        "openteam:files:read-delivery-stage",
        stagingId(id)
      ) as Promise<Uint8Array>,
    discardDeliveryStages: (ids: string[]) =>
      ipcRenderer.invoke("openteam:files:discard-delivery-stages", deliveryStageIds(ids)),
  },
  deliveryJournal: {
    read: (scope: string) =>
      ipcRenderer.invoke("openteam:delivery-journal:read", deliveryJournalScope(scope)),
    write: (scope: string, journal: unknown) =>
      ipcRenderer.invoke("openteam:delivery-journal:write", {
        scope: deliveryJournalScope(scope),
        journal: deliveryJournal(journal),
      }),
  },
  tailscale: {
    request: (request: { serverUrl: string; action: "status" | "enable" | "disable"; httpsPort?: string }) => ipcRenderer.invoke("openteam:tailscale", request),
  },
  updates: {
    status: () => ipcRenderer.invoke("openteam:updates:status"),
    check: () => ipcRenderer.invoke("openteam:updates:check"),
    openDownload: () => ipcRenderer.invoke("openteam:updates:open-download"),
    installClient: () => ipcRenderer.invoke("openteam:updates:install-client"),
    onClientProgress: (listener: (status: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: unknown) => listener(status);
      ipcRenderer.on("openteam:desktop-update-progress", handler);
      return () => ipcRenderer.removeListener("openteam:desktop-update-progress", handler);
    },

  },
  microphone: {
    status: () => ipcRenderer.invoke("openteam:microphone:status"),
    requestPermission: () => ipcRenderer.invoke("openteam:microphone:request-permission"),
    openSettings: () => ipcRenderer.invoke("openteam:microphone:open-settings"),
  },
  notifications: {
    clear: () => ipcRenderer.send("openteam:notifications:clear"),
    activity: () => ipcRenderer.invoke("openteam:notifications:activity"),
    onActivityChange: (callback: () => void) => {
      ipcRenderer.on("openteam:notifications:activity-changed", callback);
      return () => ipcRenderer.removeListener("openteam:notifications:activity-changed", callback);
    },
    sync: (snapshot: unknown) =>
      ipcRenderer.send("openteam:notifications:sync", notificationSnapshot(snapshot)),
    setVisibleChannel: (channelId: string | null) => {
      if (
        channelId !== null &&
        (typeof channelId !== "string" || !channelId.trim() || channelId.length > 512)
      ) {
        throw new Error("Visible notification channel is invalid");
      }
      ipcRenderer.send("openteam:notifications:visible-channel", channelId);
    },
    status: () => ipcRenderer.invoke("openteam:notifications:status"),
    openSettings: () => ipcRenderer.invoke("openteam:notifications:open-settings"),
  },
  /** Rebindable app shortcuts (Settings › Keyboard), and the ones only main sees (Fn). */
  shortcuts: {
    get: () => ipcRenderer.invoke("openteam:shortcuts:get"),
    set: (action: string, binding: string | null) => ipcRenderer.invoke("openteam:shortcuts:set", action, binding),
    recordFn: (recording: boolean) => ipcRenderer.invoke("openteam:shortcuts:record-fn", recording === true),
    onChange: (callback: (view: unknown) => void) => listen("openteam:shortcuts-changed", callback),
    onShortcut: (callback: (action: string) => void) => listen("openteam:shortcut", (action) => { if (typeof action === "string") callback(action); }),
  },
  screenbot: {
    /** Bots the floating screenbot composer can send to, most recent first. */
    publishRoster: (roster: unknown) => ipcRenderer.send("openteam:screenbot:roster", record(roster, "ScreenBot roster")),
    /** Delivers a ScreenBot already staged on disk by main (which validated it): only a
     * reference crosses IPC. */
    onDeliver: (handler: (request: ScreenBotDelivery) => Promise<void>) => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const request = record(value, "ScreenBot delivery") as unknown as ScreenBotDelivery & { requestId: string };
        const reply = (result: object) => ipcRenderer.send("openteam:screenbot:delivered", { requestId: request.requestId, ...result });
        stagingId(request.staged?.stagingId);
        handler(request).then(
          () => reply({ ok: true }),
          (error: unknown) => reply({ ok: false, error: screenBotError(error, "This screenshot couldn’t be sent.") })
        );
      };
      ipcRenderer.on("openteam:screenbot:deliver", listener);
      return () => ipcRenderer.removeListener("openteam:screenbot:deliver", listener);
    },
    /** Dictation in the screenbot composer: transcribe a recording made by the overlay. */
    onTranscribe: (handler: (request: { accountScope: string; audio: Uint8Array; mimeType: string }) => Promise<string>) => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const { requestId, accountScope, audio, mimeType } = record(value, "ScreenBot transcription");
        const reply = (result: object) => ipcRenderer.send("openteam:screenbot:delivered", { requestId, ...result });
        if (typeof accountScope !== "string" || !(audio instanceof Uint8Array) || typeof mimeType !== "string") return reply({ ok: false, error: "That recording couldn’t be used." });
        handler({ accountScope, audio, mimeType }).then(
          (text) => reply({ ok: true, text }),
          (error: unknown) => reply({ ok: false, error: screenBotError(error, "Transcription failed. Try again.") })
        );
      };
      ipcRenderer.on("openteam:screenbot:transcribe", listener);
      return () => ipcRenderer.removeListener("openteam:screenbot:transcribe", listener);
    },
    /** The screenbot trigger: both ⌘ keys by default, or a shortcut of the person's choosing. */
    shortcut: {
      get: () => ipcRenderer.invoke("openteam:screenbot:shortcut:get"),
      set: (shortcut: unknown) => ipcRenderer.invoke("openteam:screenbot:shortcut:set", shortcut),
      reset: () => ipcRenderer.invoke("openteam:screenbot:shortcut:set", null),
      setRecording: (recording: boolean) => ipcRenderer.invoke("openteam:screenbot:shortcut:recording", recording === true),
      requestAccess: () => ipcRenderer.invoke("openteam:screenbot:shortcut:request-access"),
      onChange: (callback: (status: unknown) => void) => {
        return listen("openteam:screenbot:shortcut-changed", callback);
      },
    },
    /** Main asks for a fresh Bot list each time a ScreenBot is taken. */
    onRosterRequest: (callback: () => void) => {
      return listen("openteam:screenbot:roster-request", () => callback());
    },
  },
  getProcessMetrics: () => ipcRenderer.invoke("openteam:performance-snapshot"),
  onNotificationClick: (
    listener: (target: DesktopNotificationTarget) => void
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, target: unknown) => {
      const parsed = parseNotificationTarget(target);
      if (parsed) listener(parsed);
    };
    ipcRenderer.on("openteam:notification-click", handler);
    return () => ipcRenderer.removeListener("openteam:notification-click", handler);
  },
  versions: Object.freeze({
    app: appVersion,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  }),
});
