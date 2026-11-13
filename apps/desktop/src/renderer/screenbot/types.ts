export interface ScreenBotBot {
  id: string;
  name: string;
  title: string;
  color: string;
  icon: string;
  channelId: string;
  avatarDataUrl?: string;
}

export interface ScreenBotRoster {
  accountScope?: string | null;
  bots: ScreenBotBot[];
  dictation: boolean;
  theme?: "light" | "dark" | "system";
  /** Increases with every list main receives; older ones are ignored. */
  version?: number;
}

export interface ScreenBotRect { x: number; y: number; width: number; height: number }

/** Mirrors `ScreenBotShot` in src/main/screenbot.ts. */
export interface ScreenBotShot {
  accountScope: string;
  id: string;
  image: Uint8Array;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  /** The display's work area (no menu bar or Dock), in overlay coordinates. */
  workArea: ScreenBotRect;
  roster: ScreenBotRoster;
  rosterVersion: number;
  draft: string;
}

export type ScreenBotSendResult = { ok: true; botName: string } | { ok: false; error: string };

export interface ScreenBotBridge {
  platform: string;
  onShot(callback: (shot: ScreenBotShot) => void): () => void;
  onRoster(callback: (roster: ScreenBotRoster) => void): () => void;
  onReset(callback: () => void): () => void;
  onHidden(callback: () => void): () => void;
  ready(shotId: string): void;
  setInteractive(interactive: boolean): void;
  focus(): void;
  saveDraft(draft: string, shotId: string, accountScope: string): void;
  send(request: { shotId: string; botId: string; content: string }): Promise<ScreenBotSendResult>;
  transcribe(audio: Uint8Array, mimeType: string, shotId: string, accountScope: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  close(shotId: string): void;
  openChat(botId: string, accountScope: string): void;
  shortcuts: { get(): Promise<KeyboardShortcutsView>; onChange(callback: (view: KeyboardShortcutsView) => void): () => void };
  onShortcut(callback: (action: string) => void): () => void;
}

declare global {
  interface Window {
    screenbot?: ScreenBotBridge;
  }
}
