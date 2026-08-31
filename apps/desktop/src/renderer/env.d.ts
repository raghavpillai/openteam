interface Window {
  openbot?: {
    platform: string;
    permissions: {
      get: () => Promise<OpenBotPermissionSettings>;
      update: (request: {
        machineLabel?: string;
        localToolPermission?: OpenBotPermissionSettings["localToolPermission"];
        autoReviewEnabled?: boolean;
      }) => Promise<OpenBotPermissionSettings>;
      addRule: (request: {
        kind: "allow" | "block";
        instruction: string;
      }) => Promise<OpenBotPermissionSettings>;
      removeRule: (request: {
        kind: "allow" | "block";
        instruction: string;
      }) => Promise<OpenBotPermissionSettings>;
    };
    showImageContextMenu: (request: {
      altText: string;
      sourceUrl: string;
      x: number;
      y: number;
    }) => void;
    files: {
      downloadAll: (
        files: Array<{ fileName: string; url: string }>
      ) => Promise<{ canceled: boolean; saved: number; directory: string | null }>;
    };
    updates: {
      status: () => Promise<OpenBotUpdateStatus>;
      check: () => Promise<OpenBotUpdateStatus>;
      openDownload: () => Promise<void>;
    };
    notifications: {
      sync: (snapshot: {
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
      status: () => Promise<{
        supported: boolean;
        platform: string;
        delivered: Array<{ id: string; title: string; body: string }>;
      }>;
      openSettings: () => Promise<void>;
    };
    onNotificationClick: (listener: (channelId: string) => void) => () => void;
    versions: Readonly<{ app: string; electron: string; chrome: string }>;
  };
}

interface OpenBotPermissionSettings {
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

interface OpenBotUpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  downloadUrl: string;
  status: "idle" | "checking" | "up-to-date" | "available" | "error";
  message: string | null;
}
