import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  COMPUTER_TOOL,
  SCREENSHOT_TOOL,
  SEND_TO_USER_TOOL,
  SEND_TO_AGENT_TOOL,
} from "@openbot/contracts";
import type {
  ApprovalRequest,
  InitializeResponse,
  RpcNotification,
  RpcRequest,
  RpcResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnStartResponse,
} from "./protocol";

type NotificationListener = (message: RpcNotification) => void;
type ApprovalListener = (approval: PendingApproval) => void;
type ExitListener = (error: CodexProtocolError) => void;
type DynamicToolListener = (request: PendingDynamicTool) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface PendingApproval {
  approvalId: string;
  rpcId: string | number;
  method: string;
  params: ApprovalRequest;
}

export interface PendingDynamicTool {
  rpcId: string | number;
  method: string;
  params: {
    threadId: string;
    turnId: string;
    callId: string;
    namespace: string | null;
    tool: string;
    arguments: unknown;
  };
}

export interface CodexClientOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface AccountStatus {
  account: { type: "apiKey" } | { type: "chatgpt"; email: string | null; planType: string } | null;
  requiresOpenaiAuth: boolean;
}

export class CodexProtocolError extends Error {
  constructor(
    message: string,
    readonly data?: unknown
  ) {
    super(message);
    this.name = "CodexProtocolError";
  }
}

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingCall>();
  private readonly notifications = new Set<NotificationListener>();
  private readonly approvalListeners = new Set<ApprovalListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private readonly dynamicToolListeners = new Set<DynamicToolListener>();
  private readonly approvals = new Map<string, PendingApproval>();
  private startPromise: Promise<InitializeResponse> | null = null;
  private init: InitializeResponse | null = null;
  private stderrTail = "";

  constructor(private readonly options: CodexClientOptions = {}) {}

  get ready(): boolean {
    return this.process !== null && this.init !== null;
  }

  get diagnostics(): { ready: boolean; userAgent?: string; platform?: string; stderrTail: string } {
    return {
      ready: this.ready,
      userAgent: this.init?.userAgent,
      platform: this.init ? `${this.init.platformOs}/${this.init.platformFamily}` : undefined,
      stderrTail: this.stderrTail,
    };
  }

  async start(): Promise<InitializeResponse> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess();
    try {
      return await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  private async startProcess(): Promise<InitializeResponse> {
    const command = this.options.command ?? process.env.OPENBOT_CODEX_BIN ?? "codex";
    const args = this.options.args ?? ["app-server", "--listen", "stdio://"];
    const childEnv = { ...process.env, ...this.options.env };
    delete childEnv.OPENBOT_CONTROL_TOKEN;
    delete childEnv.DATABASE_URL;
    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_000);
    });
    child.once("exit", (code, signal) => {
      const error = new CodexProtocolError(
        `codex app-server exited (${code ?? "no code"}, ${signal ?? "no signal"})`,
        { stderr: this.stderrTail }
      );
      if (this.process !== child) return;
      this.process = null;
      this.init = null;
      this.startPromise = null;
      this.approvals.clear();
      for (const call of this.pending.values()) call.reject(error);
      this.pending.clear();
      for (const listener of this.exitListeners) listener(error);
    });
    child.once("error", (error) => {
      if (this.process !== child) return;
      this.process = null;
      this.init = null;
      this.startPromise = null;
      this.approvals.clear();
      for (const call of this.pending.values()) call.reject(error);
      this.pending.clear();
      const protocolError = new CodexProtocolError("codex app-server failed to start", {
        cause: error.message,
      });
      for (const listener of this.exitListeners) listener(protocolError);
    });

    const response = await this.request<InitializeResponse>("initialize", {
      clientInfo: { name: "openbot", title: "OpenBot", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.send({ method: "initialized" });
    this.init = response;
    return response;
  }

  async stop(): Promise<void> {
    const child = this.process;
    const error = new CodexProtocolError("codex app-server client stopped");
    this.process = null;
    this.init = null;
    this.startPromise = null;
    this.approvals.clear();
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
    if (!child || child.killed) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  onNotification(listener: NotificationListener): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onApproval(listener: ApprovalListener): () => void {
    this.approvalListeners.add(listener);
    return () => this.approvalListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onDynamicTool(listener: DynamicToolListener): () => void {
    this.dynamicToolListeners.add(listener);
    return () => this.dynamicToolListeners.delete(listener);
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.process) {
      if (method === "initialize") throw new CodexProtocolError("app-server process is absent");
      await this.start();
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  startThread(input: { cwd: string; instructions: string }): Promise<ThreadStartResponse> {
    return this.request("thread/start", {
      cwd: input.cwd,
      approvalPolicy: "on-request",
      // Codex already runs inside OpenBot's locked-down computer container. Its
      // Linux workspace sandbox relies on unprivileged namespaces, which are
      // intentionally unavailable under the container's no-new-privileges
      // profile. Run without a second nested sandbox so ordinary shell tools
      // work while Docker remains the actual isolation boundary.
      sandbox: "danger-full-access",
      serviceName: "openbot",
      developerInstructions: input.instructions,
      dynamicTools: [SEND_TO_USER_TOOL, SEND_TO_AGENT_TOOL, SCREENSHOT_TOOL, COMPUTER_TOOL],
      ephemeral: false,
    });
  }

  resumeThread(input: {
    threadId: string;
    cwd: string;
    instructions: string;
  }): Promise<ThreadResumeResponse> {
    return this.request("thread/resume", {
      threadId: input.threadId,
      cwd: input.cwd,
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      developerInstructions: input.instructions,
      dynamicTools: [SEND_TO_USER_TOOL, SEND_TO_AGENT_TOOL, SCREENSHOT_TOOL, COMPUTER_TOOL],
    });
  }

  startTurn(input: {
    threadId: string;
    content: string;
    clientMessageId: string;
    cwd: string;
  }): Promise<TurnStartResponse> {
    return this.request("turn/start", {
      threadId: input.threadId,
      clientUserMessageId: input.clientMessageId,
      input: [{ type: "text", text: input.content, text_elements: [] }],
      cwd: input.cwd,
    });
  }

  interrupt(threadId: string, turnId: string): Promise<Record<string, never>> {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  compact(threadId: string): Promise<Record<string, never>> {
    return this.request("thread/compact/start", { threadId });
  }

  accountStatus(): Promise<AccountStatus> {
    return this.request("account/read", { refreshToken: false });
  }

  async resolveApproval(approvalId: string, decision: "accept" | "decline" | "cancel") {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new CodexProtocolError("Approval is no longer pending", { approvalId });
    if (
      approval.method !== "item/commandExecution/requestApproval" &&
      approval.method !== "item/fileChange/requestApproval" &&
      approval.method !== "item/permissions/requestApproval"
    ) {
      throw new CodexProtocolError(`Unsupported approval method: ${approval.method}`);
    }
    this.send({ id: approval.rpcId, result: { decision } });
    this.approvals.delete(approvalId);
  }

  resolveDynamicTool(
    rpcId: string | number,
    result: {
      contentItems: Array<
        { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }
      >;
      success: boolean;
    }
  ): void {
    this.send({ id: rpcId, result });
  }

  private send(message: RpcRequest | RpcNotification | RpcResponse): void {
    if (!this.process?.stdin.writable) throw new CodexProtocolError("app-server stdin is closed");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: RpcRequest | RpcNotification | RpcResponse;
    try {
      message = JSON.parse(line) as RpcRequest | RpcNotification | RpcResponse;
    } catch {
      this.stderrTail = `${this.stderrTail}\nInvalid JSONL: ${line}`.slice(-8_000);
      return;
    }

    if ("id" in message && !("method" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(new CodexProtocolError(message.error.message, message.error));
      else pending.resolve(message.result);
      return;
    }

    if ("id" in message && "method" in message) {
      const params = (message.params ?? {}) as ApprovalRequest;
      if (message.method === "item/tool/call") {
        const request: PendingDynamicTool = {
          rpcId: message.id,
          method: message.method,
          params: params as unknown as PendingDynamicTool["params"],
        };
        if (this.dynamicToolListeners.size === 0) {
          this.send({
            id: message.id,
            result: {
              contentItems: [{ type: "inputText", text: "OpenBot tool host is unavailable" }],
              success: false,
            },
          });
        } else {
          for (const listener of this.dynamicToolListeners) listener(request);
        }
      } else if (message.method.endsWith("requestApproval")) {
        const approval: PendingApproval = {
          approvalId: crypto.randomUUID(),
          rpcId: message.id,
          method: message.method,
          params,
        };
        this.approvals.set(approval.approvalId, approval);
        for (const listener of this.approvalListeners) listener(approval);
      } else {
        this.send({
          id: message.id,
          error: { code: -32601, message: `OpenBot does not support ${message.method}` },
        });
      }
      return;
    }

    if ("method" in message) {
      for (const listener of this.notifications) listener(message);
    }
  }
}
