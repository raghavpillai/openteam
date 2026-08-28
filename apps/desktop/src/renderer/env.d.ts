interface Window {
  openbot?: {
    platform: string;
    showImageContextMenu: (request: {
      altText: string;
      sourceUrl: string;
      x: number;
      y: number;
    }) => void;
    showNotification: (request: {
      channelId: string;
      title: string;
      body: string;
      kind: "agent-needs-input" | "agent-done";
    }) => void;
    onNotificationClick: (listener: (channelId: string) => void) => () => void;
    versions: Readonly<{ electron: string; chrome: string }>;
  };
}
