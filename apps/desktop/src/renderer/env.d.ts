interface Window {
  openteam?: {
    platform: string;
    clipboard?: {
      readText(): Promise<string>;
      writeText(text: string): Promise<void>;
      setComputerActive(active: boolean): void;
      onComputerAction(callback: (action: "copy" | "cut" | "paste") => void): () => void;
    };
    onMenuAction?: (listener: (action: "about" | "updates" | "settings") => void) => () => void;
    visibility?: { subscribe: (callback: (visible: boolean) => void) => () => void };
    auth: {
      connectMachine: (serverUrl: string) => Promise<{ machineId: string }>;
      machineStatus: () => Promise<{ machineId: string; connected: boolean; configured: boolean; error: string | null }>;
      signIn: (
        serverUrl: string,
        username: string,
        password: string
      ) => Promise<import("@openteam/client-core").OpenTeamSignInResult>;
      signOut: (serverUrl: string, token: string) => Promise<void>;
      readToken: () => Promise<OpenTeamAuthTokenStorageResult>;
      writeToken: (token: string) => Promise<OpenTeamAuthTokenStorageResult>;
      clearToken: () => Promise<OpenTeamAuthTokenStorageResult>;
    };
    pluginOAuth?: {
      start(connectionId: string, force?: boolean): Promise<{ authorizationUrl: string; status: string }>;
      cancel(connectionId: string, state: string): Promise<boolean>;
      close(): Promise<void>;
      onResult(callback: (result: { connectionId: string; status: "ready" | "cancelled" | "error"; message?: string }) => void): () => void;
    };
    /** An OpenTeam server installed on this computer by the CLI, if any. */
    localServer?: {
      detect(): Promise<{ url: string; username?: string } | null>;
    };
    /** Catches a model provider's localhost sign-in redirect on this computer. */
    providerSignIn?: {
      capture(
        authorizationUrl: string,
        redirectUri: string
      ): Promise<
        | { status: "captured"; callbackUrl: string }
        | { status: "unavailable"; message: string }
        | { status: "cancelled" }
      >;
      cancel(): Promise<void>;
    };
    computer: {
      get: () => Promise<OpenTeamComputerSettings>;
      update: (request: { machineLabel?: string; messagesEnabled?: boolean }) => Promise<OpenTeamComputerSettings>;
      messagesPermissions: (request?: "fullDiskAccess" | "automation" | "contacts") => Promise<OpenTeamMessagesPermissions | null>;
      messagesIcon?: () => Promise<string | null>;
      onMessagesGrantsNeeded?: (listener: () => void) => () => void;
    };
    files: {
      downloadAll: (
        files: Array<{ fileName: string; url: string }>
      ) => Promise<{ canceled: boolean; saved: number; directory: string | null }>;
      stageDelivery: (request: { stagingId: string; bytes: ArrayBuffer }) => Promise<void>;
      readDeliveryStage: (stagingId: string) => Promise<Uint8Array>;
      discardDeliveryStages: (stagingIds: string[]) => Promise<void>;
    };
    deliveryJournal: {
      read: (scope: string) => Promise<unknown>;
      write: (scope: string, journal: unknown) => Promise<void>;
    };
    tailscale: {
      request: (request: { serverUrl: string; action: "status" | "enable" | "disable"; httpsPort?: string }) => Promise<import("@openteam/contracts/tailscale").DesktopTailscaleStatus>;
    };
    updates: {
      status: () => Promise<OpenTeamUpdateStatus>;
      check: () => Promise<OpenTeamUpdateStatus>;
      openDownload: () => Promise<void>;
      installClient: () => Promise<void>;
      onClientProgress: (listener: (status: OpenTeamUpdateStatus) => void) => () => void;

    };
    microphone: {
      status: () => Promise<{
        permission: "not-determined" | "granted" | "denied" | "restricted" | "unknown";
        canOpenSettings: boolean;
        canRequestPermission: boolean;
      }>;
      requestPermission: () => Promise<boolean>;
      openSettings: () => Promise<void>;
    };
    notifications: {
      clear: () => void;
      activity: () => Promise<{ active: boolean; idleSeconds: number }>;
      onActivityChange: (callback: () => void) => () => void;
      sync: (snapshot: {
        cursor?: string;
        channels: Array<
          import("@openteam/contracts/notification-content").ChannelNotificationState & {
            unreadCount: number;
          }
        >;
      }) => void;
      setVisibleChannel: (channelId: string | null) => void;
      status: () => Promise<{
        supported: boolean;
        platform: string;
        delivered: Array<{ id: string; title: string; body: string }>;
      }>;
      openSettings: () => Promise<void>;
    };
    getProcessMetrics: () => Promise<{
      at: number;
      app: Electron.ProcessMetric[];
      main: Electron.ProcessMemoryInfo;
      gpu: Electron.GPUFeatureStatus;
    }>;
    onNotificationClick: (
      listener: (target: { channelId: string; threadMessageId?: string }) => void
    ) => () => void;
    versions: Readonly<{ app: string; electron: string; chrome: string }>;
  };
}

interface OpenTeamAuthTokenStorageResult {
  token: string | null;
  persistence: "disk";
  backend: string;
}

interface OpenTeamComputerSettings {
  version: 1;
  machine: {
    machineId: string;
    label: string;
  };
  messagesEnabled: boolean;
  messagesSupported: boolean;
}

interface OpenTeamMessagesPermissions {
  fullDiskAccess: boolean;
  automation: "granted" | "denied" | "notAsked" | "unknown";
  contacts: "granted" | "denied" | "notAsked" | "unknown";
}

interface OpenTeamUpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  downloadUrl: string;
  status:
    | "idle"
    | "checking"
    | "up-to-date"
    | "available"
    | "downloading"
    | "backing-up"
    | "downloaded"
    | "installing"
    | "error";
  progress: number | null;
  message: string | null;
  failureKind:
    | "service-unavailable"
    | "feed-http-status"
    | "feed-malformed"
    | "signature-invalid"
    | "download-failed"
    | "apply-unsupported"
    | "unknown"
    | null;
  track: "stable";
}

type OpenTeamServerUpdateStatus = import("@openteam/contracts").ServerUpdateView & {
  serverUrl: string;
  currentVersion: string | null;
  apiProtocolVersion: number | null;
  minimumClientVersion: string | null;
  maximumClientVersionExclusive: string | null;
  recommendedClientVersion: string | null;
  manualCommand: string;
};
