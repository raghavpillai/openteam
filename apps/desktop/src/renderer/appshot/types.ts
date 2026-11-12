export interface AppshotBot {
  id: string;
  name: string;
  title: string;
  color: string;
  icon: string;
  channelId: string;
  avatarDataUrl?: string;
}

export interface AppshotRoster {
  bots: AppshotBot[];
  dictation: boolean;
  theme?: "light" | "dark" | "system";
  /** Increases with every list main receives; older ones are ignored. */
  version?: number;
}

export interface AppshotRect { x: number; y: number; width: number; height: number }

/** Mirrors `AppshotShot` in src/main/appshot.ts. */
export interface AppshotShot {
  id: string;
  image: Uint8Array;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  /** The display's work area (no menu bar or Dock), in overlay coordinates. */
  workArea: AppshotRect;
  roster: AppshotRoster;
  rosterVersion: number;
  draft: string;
}

export type AppshotSendResult = { ok: true; botName: string } | { ok: false; error: string };

export interface AppshotBridge {
  platform: string;
  onShot(callback: (shot: AppshotShot) => void): () => void;
  onRoster(callback: (roster: AppshotRoster) => void): () => void;
  ready(): void;
  setInteractive(interactive: boolean): void;
  focus(): void;
  saveDraft(draft: string): void;
  send(request: { shotId: string; botId: string; content: string }): Promise<AppshotSendResult>;
  transcribe(audio: Uint8Array, mimeType: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  close(shotId: string): void;
  openChat(botId: string): void;
}

declare global {
  interface Window {
    appshot?: AppshotBridge;
  }
}
