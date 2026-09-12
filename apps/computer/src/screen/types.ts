import type { ChildProcess } from "node:child_process";

export type ScreenState = "starting" | "ready" | "failed";

export interface ScreenSession {
  botId: string;
  cwd: string;
  slot: number;
  display: number;
  rfbPort: number;
  viewerPort: number;
  viewerPassword: string;
  browserDebugPort: number;
  profileDirectory: string;
  runtimeDirectory: string;
  state: ScreenState;
  error: string | null;
  humanTakeoverUntil: number;
  agentInputPaused: boolean;
  destroyed: boolean;
  stopping: boolean;
  processes: ChildProcess[];
  browserProcess: ChildProcess | null;
  startPromise: Promise<void> | null;
  lastHealthCheckAt: number;
  healthCheckPromise: Promise<boolean> | null;
}

export interface ScreenStatus {
  botId: string;
  state: ScreenState;
  width: number;
  height: number;
  display: number;
  viewerPort: number;
  viewerPassword: string;
  humanTakeover: boolean;
  agentInputPaused: boolean;
  apps: Array<"chromium" | "thunar" | "terminal">;
  browserProfileScope: "computer";
  browserSessionScope: "computer";
  browserSessionMechanism: "shared-profiles";
  browserStateCoverage: Array<
    | "cookies"
    | "local-storage"
    | "session-storage"
    | "indexed-db"
    | "service-workers"
    | "cache-storage"
    | "extensions"
    | "saved-passwords"
    | "client-certificates"
    | "settings"
    | "bookmarks"
    | "history"
    | "open-tabs"
  >;
  browserTargetRouting: "bot-owned-tabs";
  error: string | null;
}
