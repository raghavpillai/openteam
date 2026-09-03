import { contextBridge, ipcRenderer } from "electron";

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
  persistence: "encrypted" | "memory";
  backend: string;
};

const authTokenStorageResult = (value: unknown): AuthTokenStorageResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Secure authentication storage returned an invalid response");
  }
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.token !== null && typeof candidate.token !== "string") ||
    !["encrypted", "memory"].includes(String(candidate.persistence)) ||
    typeof candidate.backend !== "string"
  ) {
    throw new Error("Secure authentication storage returned an invalid response");
  }
  return candidate as AuthTokenStorageResult;
};

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const permissionUpdate = (value: unknown) => {
  const input = record(value, "Permission update");
  if (
    input.machineLabel !== undefined &&
    (typeof input.machineLabel !== "string" ||
      !input.machineLabel.trim() ||
      input.machineLabel.length > 80)
  ) {
    throw new Error("Machine label is invalid");
  }
  if (
    input.localToolPermission !== undefined &&
    !["always", "ask", "never"].includes(String(input.localToolPermission))
  ) {
    throw new Error("Local tool permission is invalid");
  }
  if (input.autoReviewEnabled !== undefined && typeof input.autoReviewEnabled !== "boolean") {
    throw new Error("Auto Review setting is invalid");
  }
  return value;
};

const permissionRule = (value: unknown) => {
  const input = record(value, "Permission rule");
  if (
    !["allow", "block"].includes(String(input.kind)) ||
    typeof input.instruction !== "string" ||
    !input.instruction.trim() ||
    input.instruction.length > 1_000
  ) {
    throw new Error("Permission rule is invalid");
  }
  return value;
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

const serverUpdateRequest = (value: unknown) => {
  const input = record(value, "Server update request");
  if (
    typeof input.serverUrl !== "string" ||
    !input.serverUrl.trim() ||
    input.serverUrl.length > 2_000
  ) {
    throw new Error("Server URL is invalid");
  }
  for (const field of ["targetVersion", "sshTarget"] as const) {
    if (input[field] !== undefined && input[field] !== null && typeof input[field] !== "string") {
      throw new Error(`Server update ${field} is invalid`);
    }
  }
  return value;
};

const notificationSnapshot = (value: unknown) => {
  const input = record(value, "Notification snapshot");
  if (!Array.isArray(input.agents) || input.agents.length > 10_000) {
    throw new Error("Notification snapshot is invalid");
  }
  return value;
};

contextBridge.exposeInMainWorld("openteam", {
  platform: process.platform,
  auth: {
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
  permissions: {
    get: () => ipcRenderer.invoke("openteam:permissions:get"),
    update: (request: {
      machineLabel?: string;
      localToolPermission?: "always" | "ask" | "never";
      autoReviewEnabled?: boolean;
    }) => ipcRenderer.invoke("openteam:permissions:update", permissionUpdate(request)),
    addRule: (request: { kind: "allow" | "block"; instruction: string }) =>
      ipcRenderer.invoke("openteam:permissions:add-rule", permissionRule(request)),
    removeRule: (request: { kind: "allow" | "block"; instruction: string }) =>
      ipcRenderer.invoke("openteam:permissions:remove-rule", permissionRule(request)),
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
    serverStatus: (request: {
      serverUrl: string;
      targetVersion?: string | null;
      sshTarget?: string | null;
    }) => ipcRenderer.invoke("openteam:updates:server-status", serverUpdateRequest(request)),
    updateServer: (request: {
      serverUrl: string;
      targetVersion?: string | null;
      sshTarget?: string | null;
    }) => ipcRenderer.invoke("openteam:updates:update-server", serverUpdateRequest(request)),
    onServerProgress: (listener: (status: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: unknown) => listener(status);
      ipcRenderer.on("openteam:server-update-progress", handler);
      return () => ipcRenderer.removeListener("openteam:server-update-progress", handler);
    },
  },
  notifications: {
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
  getProcessMetrics: () => ipcRenderer.invoke("openteam:performance-snapshot"),
  onNotificationClick: (listener: (channelId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, channelId: unknown) => {
      if (typeof channelId === "string") listener(channelId);
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
