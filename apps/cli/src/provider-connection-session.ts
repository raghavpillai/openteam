import type { InteractiveOutcome, InteractiveSession } from "./interactive-session";
import type { AuthSession, ProviderConnectionAPI } from "./provider-connection-api";
import type { SessionKey } from "./setup-session";
import { TerminalReport } from "./terminal";
import type { SetupSessionFrame } from "./ui";

export type ConnectionResult = "connected" | "cancelled";
type Action = { id: string; label: string; detail?: string };
const CONTINUE = { type: "continue" } as const;

export class ProviderConnectionSession implements InteractiveSession<ConnectionResult> {
  private listener?: (outcome?: InteractiveOutcome<ConnectionResult>) => void;
  private session: AuthSession | null = null;
  private cursor = 0;
  private buffer: string | null = null;
  private pending = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setTimeout>;
  private busy = "";
  private notice = "";
  private closing = false;
  private finished = false;
  private connected = false;
  private showLink = false;
  private generation = 0;
  private importAbort?: AbortController;

  constructor(
    readonly providerId: string,
    readonly authType: "oauth" | "api_key",
    private readonly api: ProviderConnectionAPI,
    private readonly links: { open(url: string): Promise<void>; copy(url: string): Promise<void> },
    private readonly pollMs = 1000,
    private readonly context: "model" | "provider" = "model"
  ) {
    if (authType === "api_key") this.buffer = "";
  }
  subscribe(listener: (outcome?: InteractiveOutcome<ConnectionResult>) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
      clearTimeout(this.timer);
    };
  }
  private get name() {
    return this.providerId === "anthropic"
      ? "Claude"
      : this.providerId === "openai-codex"
        ? "ChatGPT"
        : this.providerId === "openai"
          ? "OpenAI"
          : this.providerId;
  }
  private get localName() {
    return this.providerId === "anthropic"
      ? "Claude Code"
      : this.providerId === "openai-codex"
        ? "Codex"
        : null;
  }
  private get url() {
    const raw = this.session?.deviceCode?.verificationUri ?? this.session?.authorizationUrl;
    if (!raw) return null;
    try {
      const url = new URL(raw);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
    } catch {
      return null;
    }
  }
  private get initial() {
    return !this.session && !this.connected;
  }
  private get backLabel() {
    return this.context === "model" ? "Back to providers" : "Cancel";
  }
  private get cancelLabel() {
    return this.context === "model" ? "Cancel and go back" : "Cancel sign-in";
  }
  actions(): Action[] {
    if (this.closing) return [];
    if (this.connected)
      return [{ id: "done", label: this.context === "model" ? "Continue to models" : "Done" }];
    if (this.buffer !== null) return [];
    if (this.initial) {
      if (this.authType === "api_key")
        return [
          { id: "paste", label: "Enter API key" },
          { id: "cancel", label: this.backLabel },
        ];
      return [
        ...(this.localName
          ? [
              {
                id: "import",
                label: "Use " + this.localName + " login",
                detail: "Import the login saved on this computer into this OpenTeam server.",
              },
            ]
          : []),
        {
          id: "browser",
          label: "Browser sign-in",
          detail: "Connect an account with a new sign-in.",
        },
        { id: "cancel", label: this.backLabel },
      ];
    }
    if (this.session?.status === "failed" || this.session?.status === "cancelled")
      return [
        { id: "retry", label: "Try again" },
        { id: "cancel", label: this.backLabel },
      ];
    if (this.session?.prompt?.type === "select")
      return [
        ...(this.session.prompt.options ?? []).map((option) => ({
          id: "option:" + option.id,
          label: option.label,
          detail: option.description,
        })),
        { id: "cancel", label: this.cancelLabel },
      ];
    return [
      ...(this.url
        ? [
            { id: "open", label: "Open sign-in page", detail: new URL(this.url).hostname },
            { id: "copy", label: "Copy sign-in link" },
          ]
        : []),
      ...(this.session?.prompt
        ? [
            {
              id: "paste",
              label:
                this.session.prompt.type === "secret"
                  ? "Enter API key"
                  : "Paste code or redirect URL",
              detail: "Use this if the browser cannot return to OpenTeam.",
            },
          ]
        : []),
      ...(this.url
        ? [{ id: "link", label: this.showLink ? "Hide sign-in link" : "Show sign-in link" }]
        : []),
      { id: "cancel", label: this.cancelLabel },
    ];
  }
  frame(width: number | undefined, color: boolean): SetupSessionFrame {
    const header = new TerminalReport({ width, color });
    header.text("OPENTEAM / " + this.context, "info");
    header.section("Connect " + this.name);
    header.text(
      this.authType === "oauth" ? "Subscription access" : "API access · billed by your provider"
    );
    const body = new TerminalReport({ width, color });
    if (this.connected)
      body.notice(
        this.context === "model" ? "Connected. Choose a model next." : "Connected. Ready to use.",
        "success"
      );
    else if (this.initial && this.authType === "oauth")
      body.text("Use a saved login, or sign in with your browser.");
    else if (this.session?.status === "failed")
      body.notice(
        "The provider could not complete sign-in. Retry, or use another connection method.",
        "warning"
      );
    else if (this.session?.status === "cancelled") body.text("This sign-in was cancelled.");
    else if (this.session?.deviceCode) {
      body.text("Open the sign-in page and enter this code:");
      body.text(this.session.deviceCode.userCode, "info");
    } else if (this.session?.prompt?.type === "select") body.text("Choose how to sign in.");
    else if (this.session && !this.url && !this.session.prompt) body.text("Preparing sign-in…");
    else if (this.session)
      body.text("Finish signing in with your browser. You can cancel at any time.");
    if (this.showLink && this.url) body.text(this.url, "info");
    body.lines.push("");
    let cursorLine = body.lines.length;
    let cursorEndLine = cursorLine;
    if (this.buffer !== null) {
      body.text(
        this.authType === "api_key" || this.session?.prompt?.type === "secret"
          ? "Paste your API key"
          : "Paste the code or final redirect URL",
        "info"
      );
      body.text(
        this.buffer ? "•".repeat(Math.min(this.buffer.length, 24)) + " ▏" : "Waiting for input ▏",
        "info"
      );
      cursorEndLine = body.lines.length - 1;
      body.text("Input is hidden. Enter submits.");
    } else {
      const actions = this.actions();
      this.cursor = Math.max(0, Math.min(this.cursor, actions.length - 1));
      for (const [index, action] of actions.entries()) {
        const focused = index === this.cursor;
        if (focused) cursorLine = body.lines.length;
        body.text((focused ? "❯ " : "  ") + action.label, focused ? "info" : "muted");
        if (focused && action.detail) body.text(action.detail, "muted", 4);
        if (focused) cursorEndLine = body.lines.length - 1;
      }
    }
    const footer = new TerminalReport({ width, color });
    footer.lines.push("");
    if (this.busy) footer.text(this.busy, "info");
    if (this.notice) footer.text(this.notice, "warning");
    footer.text(
      this.buffer !== null
        ? "Enter submit · Esc back · Ctrl+C cancel"
        : "↑/↓ move · Enter choose · Esc back · Ctrl+C cancel"
    );
    return {
      header: header.lines,
      body: body.lines,
      footer: footer.lines,
      cursorLine,
      cursorEndLine,
    };
  }
  private emit() {
    if (!this.finished) this.listener?.();
  }
  private track(task: Promise<void>) {
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  private launch(label: string, action: () => Promise<void>) {
    if (this.busy || this.closing) return;
    clearTimeout(this.timer);
    this.generation++;
    this.busy = label;
    this.notice = "";
    this.track(
      (async () => {
        try {
          await action();
        } catch (error) {
          // API errors are intentionally sanitized by the transport.
          this.notice =
            error instanceof Error ? error.message : "Connection failed. Retry or go back.";
        } finally {
          this.busy = "";
          if (!this.closing) {
            this.emit();
            this.schedulePoll();
          }
        }
      })()
    );
  }
  private apply(session: AuthSession) {
    const previousPrompt = this.session?.prompt?.id;
    this.session = session;
    if (session.status === "connected") {
      this.connected = true;
      this.buffer = null;
      this.cursor = 0;
    } else if (previousPrompt !== session.prompt?.id && this.buffer === null) this.cursor = 0;
  }
  private schedulePoll() {
    clearTimeout(this.timer);
    if (
      this.closing ||
      this.finished ||
      this.busy ||
      !this.session ||
      ["failed", "cancelled", "connected"].includes(this.session.status)
    )
      return;
    this.timer = setTimeout(() => {
      const generation = this.generation;
      const id = this.session!.id;
      this.track(
        (async () => {
          try {
            const session = await this.api.read(id);
            if (generation === this.generation && !this.closing) {
              const changed = JSON.stringify(this.session) !== JSON.stringify(session);
              this.apply(session);
              const recovered = this.notice.startsWith("Could not check sign-in.");
              if (recovered) this.notice = "";
              if (changed || recovered) this.emit();
            }
          } catch {
            if (!this.closing && !this.notice.startsWith("Could not check sign-in.")) {
              this.notice = "Could not check sign-in. Retrying… You can still cancel.";
              this.emit();
            }
          } finally {
            if (generation === this.generation && !this.closing) this.schedulePoll();
          }
        })()
      );
    }, this.pollMs);
  }
  private complete(result: ConnectionResult) {
    this.finished = true;
    clearTimeout(this.timer);
    this.buffer = null;
    this.listener?.({ type: "complete", value: result });
  }
  private cancel() {
    if (this.closing || this.finished) return;
    this.closing = true;
    this.importAbort?.abort();
    this.generation++;
    clearTimeout(this.timer);
    this.buffer = null;
    this.busy = "Cancelling sign-in…";
    this.notice = "";
    void (async () => {
      await Promise.allSettled([...this.pending]);
      try {
        if (this.session && !["connected", "cancelled"].includes(this.session.status))
          await this.api.cancel(this.session.id);
        this.complete("cancelled");
      } catch {
        this.closing = false;
        this.busy = "";
        this.notice = "Could not cancel the remote sign-in. Press Esc to retry cancellation.";
        this.emit();
      }
    })();
  }
  handle(character: string, key: SessionKey): InteractiveOutcome<ConnectionResult> {
    if (this.finished) return CONTINUE;
    if (key.ctrl && key.name === "c") {
      this.cancel();
      return CONTINUE;
    }
    if (key.name === "escape") {
      if (this.buffer !== null && !this.busy) {
        this.buffer = null;
        this.notice = "";
      } else this.cancel();
      return CONTINUE;
    }
    if (this.closing || this.busy) return CONTINUE;
    if (this.buffer !== null) {
      if (key.name === "return" || key.name === "enter") {
        const value = this.buffer.trim();
        if (!value) {
          this.notice = "Paste a value, or press Esc to go back.";
          return CONTINUE;
        }
        this.buffer = null;
        this.launch("Connecting…", async () => {
          if (!this.session) this.apply(await this.api.start(this.providerId, this.authType));
          for (
            let attempt = 0;
            !this.session?.prompt &&
            this.session?.status === "running" &&
            !this.closing &&
            attempt < 10;
            attempt++
          ) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            if (!this.closing) this.apply(await this.api.read(this.session.id));
          }
          if (this.closing) return;
          const prompt = this.session?.prompt;
          if (!prompt) {
            this.notice = "The provider is not ready for input yet. Wait a moment and try again.";
            return;
          }
          this.apply(await this.api.respond(this.session!.id, prompt.id, value));
        });
      } else if (key.name === "backspace")
        this.buffer = Array.from(this.buffer).slice(0, -1).join("");
      else if (key.ctrl && key.name === "u") this.buffer = "";
      else if (!key.ctrl && !key.meta && character) {
        const input = character.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
        if (this.buffer.length + input.length <= 20_000) this.buffer += input;
        else this.notice = "Input is too long. Paste only the key, code, or redirect URL.";
      }
      return CONTINUE;
    }
    const actions = this.actions();
    if (key.name === "up") this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === "down") this.cursor = Math.min(actions.length - 1, this.cursor + 1);
    else if (key.name === "home") this.cursor = 0;
    else if (key.name === "end") this.cursor = actions.length - 1;
    else if (key.name === "return" || key.name === "enter") {
      const action = actions[this.cursor]?.id;
      if (action === "cancel") this.cancel();
      else if (action === "done") return { type: "complete", value: "connected" };
      else if (action === "paste") this.buffer = "";
      else if (action === "link") this.showLink = !this.showLink;
      else if (action === "open")
        this.launch("Opening browser…", async () => {
          await this.links.open(this.url!);
          this.notice =
            "Finish signing in there. If needed, paste the final code or redirect URL here.";
        });
      else if (action === "copy")
        this.launch("Copying link…", async () => {
          await this.links.copy(this.url!);
          this.notice = "Link copied. Open it in your browser.";
        });
      else if (action === "import")
        this.launch("Importing " + this.localName + " login…", async () => {
          this.importAbort = new AbortController();
          await this.api.importLogin(this.providerId, this.importAbort.signal);
          this.connected = true;
          this.cursor = 0;
        });
      else if (action === "retry") {
        this.session = null;
        this.cursor = 0;
        this.notice = "";
        if (this.authType === "api_key") this.buffer = "";
      } else if (action === "browser")
        this.launch("Starting sign-in…", async () => {
          this.apply(await this.api.start(this.providerId, this.authType));
        });
      else if (action?.startsWith("option:"))
        this.launch("Starting sign-in…", async () => {
          this.apply(
            await this.api.respond(this.session!.id, this.session!.prompt!.id, action.slice(7))
          );
        });
    }
    return CONTINUE;
  }
  async dispose() {
    clearTimeout(this.timer);
    this.closing = true;
    this.importAbort?.abort();
    this.buffer = null;
    await Promise.allSettled([...this.pending]);
    if (!this.finished && this.session && !["connected", "cancelled"].includes(this.session.status))
      await this.api.cancel(this.session.id);
    this.finished = true;
    this.listener = undefined;
  }
}
