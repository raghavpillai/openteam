interface Window {
  openteam?: {
    platform: string;
    auth: {
      readToken: () => Promise<OpenTeamAuthTokenStorageResult>;
      writeToken: (token: string) => Promise<OpenTeamAuthTokenStorageResult>;
      clearToken: () => Promise<OpenTeamAuthTokenStorageResult>;
    };
    permissions: {
      get: () => Promise<OpenTeamPermissionSettings>;
      update: (request: {
        machineLabel?: string;
        localToolPermission?: OpenTeamPermissionSettings["localToolPermission"];
        autoReviewEnabled?: boolean;
      }) => Promise<OpenTeamPermissionSettings>;
      addRule: (request: {
        kind: "allow" | "block";
        instruction: string;
      }) => Promise<OpenTeamPermissionSettings>;
      removeRule: (request: {
        kind: "allow" | "block";
        instruction: string;
      }) => Promise<OpenTeamPermissionSettings>;
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
    updates: {
      status: () => Promise<OpenTeamUpdateStatus>;
      check: () => Promise<OpenTeamUpdateStatus>;
      openDownload: () => Promise<void>;
      installClient: () => Promise<void>;
      onClientProgress: (listener: (status: OpenTeamUpdateStatus) => void) => () => void;
      serverStatus: (request: {
        serverUrl: string;
        targetVersion?: string | null;
        sshTarget?: string | null;
      }) => Promise<OpenTeamServerUpdateStatus>;
      updateServer: (request: {
        serverUrl: string;
        targetVersion?: string | null;
        sshTarget?: string | null;
      }) => Promise<OpenTeamServerUpdateStatus>;
      onServerProgress: (listener: (status: OpenTeamServerUpdateStatus) => void) => () => void;
    };
    notifications: {
      sync: (snapshot: {
        cursor?: string;
        agents: Array<{
          botId: string;
          channelId: string;
          name: string;
          notificationsEnabled: boolean;
          hiddenFromSidebar: boolean;
          isRunning: boolean;
          awaitingReason: string | null;
          lastMessageId: string | null;
          lastMessagePreview: string | null;
          unreadCount: number;
        }>;
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
    onNotificationClick: (listener: (channelId: string) => void) => () => void;
    versions: Readonly<{ app: string; electron: string; chrome: string }>;
  };
}

interface OpenTeamAuthTokenStorageResult {
  token: string | null;
  persistence: "encrypted" | "memory";
  backend: string;
}

interface OpenTeamPermissionSettings {
  version: 1;
  localToolPermission: "always" | "ask" | "never";
  machine: {
    machineId: string;
    label: string;
  };
  autoReview: {
    isEnabled: boolean;
    allowInstructions: string[];
    blockInstructions: string[];
  };
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

interface OpenTeamServerUpdateStatus {
  serverUrl: string;
  currentVersion: string | null;
  targetVersion: string | null;
  apiProtocolVersion: number | null;
  minimumClientVersion: string | null;
  maximumClientVersionExclusive: string | null;
  recommendedClientVersion: string | null;
  updateMethod: "local" | "ssh" | "manual";
  updaterAvailable: boolean;
  status: "ready" | "updating" | "updated" | "unavailable" | "error";
  phase:
    | "checking"
    | "downloading"
    | "backing-up"
    | "pulling"
    | "restarting"
    | "verifying"
    | "rolling-back"
    | "complete"
    | null;
  message: string | null;
  manualCommand: string;
}
