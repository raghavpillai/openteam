interface Window {
  openbot?: {
    platform: string;
    versions: Readonly<{ electron: string; chrome: string }>;
  };
}
