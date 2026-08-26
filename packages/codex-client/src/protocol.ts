// Protocol subset generated from codex-cli 0.144.5 with
// `codex app-server generate-ts`. Regenerate and review before changing the
// pinned CLI version.

export type RequestId = string | number;

export interface RpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  id: RequestId;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface Thread {
  id: string;
  sessionId: string;
  cwd: string;
  cliVersion: string;
}

export interface ThreadStartResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  instructionSources: string[];
}

export type ThreadResumeResponse = ThreadStartResponse;

export interface Turn {
  id: string;
  status: string;
  items: ThreadItem[];
  error: unknown | null;
}

export interface TurnStartResponse {
  turn: Turn;
}

export type ThreadItem =
  | { type: "userMessage"; id: string; clientId: string | null; content: unknown[] }
  | { type: "agentMessage"; id: string; text: string; phase?: string | null }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: string;
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | { type: "fileChange"; id: string; changes: unknown[]; status: string }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: string;
      [key: string]: unknown;
    }
  | { type: "dynamicToolCall"; id: string; tool: string; status: string; [key: string]: unknown }
  | { type: "plan"; id: string; text: string }
  | { type: "contextCompaction"; id: string }
  | ({ type: string; id?: string } & Record<string, unknown>);

export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface ItemNotification {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}

export interface TurnNotification {
  threadId: string;
  turn: Turn;
}

export interface ApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  [key: string]: unknown;
}
