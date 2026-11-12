type AppshotShortcutView =
  | { kind: "chord"; modifier: "command" | "option" | "shift" | "control" }
  | { kind: "accelerator"; accelerator: string };

interface AppshotShortcutStatusView {
  shortcut: AppshotShortcutView;
  isDefault: boolean;
  active: boolean;
  mode: "tap" | "poll" | "shortcut" | null;
  error: string | null;
  fn: boolean;
  platform: string;
}

interface KeyboardShortcutsView {
  bindings: Record<"search" | "toggleSidebar" | "settings" | "dictate" | "previousBot" | "nextBot", string>;
  defaults: Record<"search" | "toggleSidebar" | "settings" | "dictate" | "previousBot" | "nextBot", string>;
}

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
    visibility?: {
      subscribe: (callback: (visible: boolean) => void) => () => void;
      subscribeActivity?: (callback: (active: boolean) => void) => () => void;
    };
    /** Feeds the floating appshot composer (src/renderer/lib/appshot-bridge.ts).. */
    shortcuts?: {
      get(): Promise<KeyboardShortcutsView>;
      set(action: string, binding: string | null): Promise<KeyboardShortcutsView>;
      recordFn(recording: boolean): Promise<void>;
      onChange(callback: (view: KeyboardShortcutsView) => void): () => void;
      onShortcut(callback: (action: string) => void): () => void;
    };
    appshot?: {
      publishRoster(roster: {
        bots: Array<{ id: string; name: string; title: string; color: string; icon: string; channelId: string; avatarDataUrl?: string }>;
        dictation: boolean;
      }): void;
      onTranscribe(handler: (request: { audio: Uint8Array; mimeType: string }) => Promise<string>): () => void;
      onDeliver(
        handler: (request: {
          botId: string;
          content: string;
          nonce: string;
          staged: { stagingId: string; fileName: string; mimeType: string; byteSize: number; width: number; height: number };
        }) => Promise<void>
      ): () => void;
      onRosterRequest(callback: () => void): () => void;
      shortcut: {
        get(): Promise<AppshotShortcutStatusView>;
        set(shortcut: AppshotShortcutView): Promise<AppshotShortcutStatusView>;
        reset(): Promise<AppshotShortcutStatusView>;
        setRecording(recording: boolean): Promise<void>;
        requestAccess(): Promise<boolean>;
        onChange(callback: (status: AppshotShortcutStatusView) => void): () => void;
      };
    };
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
      network: () => Promise<import("@openteam/contracts/browser-network").NetworkSharingStatus | null>;
      shareNetwork: (enabled: boolean) => Promise<import("@openteam/contracts/browser-network").NetworkSharingStatus>;
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
      listener: (target: import("@openteam/contracts/notification-content").DesktopNotificationTarget) => void
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
