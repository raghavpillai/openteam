interface Window {
  openbot?: {
    platform: string;
    showImageContextMenu: (request: {
      altText: string;
      sourceUrl: string;
      x: number;
      y: number;
    }) => void;
    versions: Readonly<{ electron: string; chrome: string }>;
  };
}
