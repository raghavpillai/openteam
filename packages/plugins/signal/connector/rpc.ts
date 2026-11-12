import { scopedProcessEnvironment } from "@openteam/plugin-sdk";

export class SignalRpcError extends Error {
  constructor(readonly code: number) {
    super(
      `Signal rejected the request (RPC ${code}). Check account status, identity trust, or rate limits.`
    );
  }
}

/** One long-lived process owns the account files and multiplexes RPC with receive events. */
export class SignalRpc {
  private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly pending = new Map<
    string,
    {
      resolve(value: any): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private buffer = "";
  private failure: Error | undefined;
  private stopping = false;
  private killTimer?: ReturnType<typeof setTimeout>;
  readonly exited: Promise<void>;

  constructor(
    command: string[],
    private readonly onReceive: (params: any) => void,
    options: { environment?: Record<string, string>; maxFrameBytes?: number } = {}
  ) {
    try {
      this.child = Bun.spawn(command, {
        env: scopedProcessEnvironment(process.env, options.environment),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
      });
    } catch {
      throw new Error("Could not launch signal-cli. Check its configured executable and runtime.");
    }
    const maximum = options.maxFrameBytes ?? 16 * 1024 * 1024;
    const output = this.child.stdout.getReader();
    const errors = this.child.stderr.getReader();
    const cancelStreams = () => {
      void output.cancel().catch(() => {});
      void errors.cancel().catch(() => {});
    };
    this.cancelStreams = cancelStreams;
    const read = async () => {
      try {
        const decoder = new TextDecoder();
        while (true) {
          const chunk = await output.read();
          if (chunk.done) break;
          this.buffer += decoder.decode(chunk.value, { stream: true });
          let boundary: number;
          while ((boundary = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, boundary);
            this.buffer = this.buffer.slice(boundary + 1);
            if (Buffer.byteLength(line) > maximum)
              throw new Error("Signal response exceeds the frame limit.");
            if (line.trim()) this.receive(JSON.parse(line));
          }
          if (Buffer.byteLength(this.buffer) > maximum)
            throw new Error("Signal response exceeds the frame limit.");
        }
        if (!this.stopping)
          this.terminate(new Error("Signal output closed. Reconnect the account."));
      } catch {
        this.terminate(
          new Error(
            "Signal returned an invalid frame or the message collector failed. Reconnect the account."
          )
        );
      }
    };
    // Drain diagnostics without copying message contents or account secrets to MCP logs.
    const diagnostics = async () => {
      while (!(await errors.read()).done) {
        /* discard */
      }
    };
    const streams = Promise.allSettled([read(), diagnostics()]);
    const processExit = this.child.exited.then(async () => {
      if (this.stopping) return;
      // Consume a final buffered reply, then fail promptly even if a descendant retains the pipes.
      await Promise.race([streams, Bun.sleep(50)]);
      this.terminate(
        new Error(
          "Signal process disconnected. A pending send may have succeeded. Inspect its request ID before sending again."
        )
      );
    });
    this.exited = Promise.allSettled([streams, processExit]).then(() => {
      this.signalProcessTree("SIGKILL");
      clearTimeout(this.killTimer);
      this.fail(
        new Error(
          "Signal process disconnected. A pending send may have succeeded. Inspect its request ID before sending again."
        )
      );
    });
  }

  private readonly cancelStreams: () => void;

  private signalProcessTree(signal: NodeJS.Signals) {
    if (process.platform !== "win32") {
      try {
        process.kill(-this.child.pid, signal);
        return;
      } catch {
        /* group may already have exited */
      }
    }
    try {
      this.child.kill(signal);
    } catch {
      /* direct child may already have exited */
    }
  }

  get connected() {
    return !this.failure && this.child.exitCode === null && !this.child.killed;
  }
  get exitCode() {
    return this.child.exitCode;
  }
  get signalCode() {
    return this.child.signalCode;
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            "Signal request timed out. A send may have succeeded. Reuse its request ID to inspect the recorded outcome."
          )
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        void Promise.resolve(this.child.stdin.flush()).catch(() => {
          this.terminate(new Error("Signal process input closed."));
        });
      } catch {
        this.terminate(new Error("Signal process input closed."));
      }
    });
  }

  private receive(frame: any) {
    if (!frame || frame.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC envelope");
    if (frame.method === "receive") {
      this.onReceive(frame.params);
      return;
    }
    const entry = this.pending.get(String(frame.id));
    if (!entry) return; // Late responses after timeouts cannot resolve another request.
    this.pending.delete(String(frame.id));
    clearTimeout(entry.timer);
    if (frame.error) entry.reject(new SignalRpcError(Number(frame.error.code)));
    else if (Object.hasOwn(frame, "result")) entry.resolve(frame.result);
    else entry.reject(new Error("Signal returned a response without a result."));
  }

  private fail(error: Error) {
    this.failure ??= error;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(this.failure);
    }
    this.pending.clear();
  }

  private terminate(error: Error, graceful = false) {
    this.fail(error);
    if (this.stopping) return;
    this.stopping = true;
    try {
      this.child.stdin.end();
    } catch {
      /* input may already be closed */
    }
    if (!graceful) this.signalProcessTree("SIGTERM");
    this.killTimer = setTimeout(() => {
      this.signalProcessTree("SIGKILL");
      this.cancelStreams();
    }, 1500);
  }

  async close() {
    this.terminate(new Error("Signal connector stopped."), true);
    await this.exited;
  }
}
