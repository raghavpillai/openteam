import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PiReasoningLevel } from "@openteam/contracts";
import type { ActiveTurn } from "./types";

/** Silence the user may sit through before the narrator speaks. */
export const NARRATION_SILENCE_MS = 3_000;
/** The server speaks a fixed acknowledgement as soon as the user stops talking; the first narration allows for it. */
export const NARRATION_OPENING_ALLOWANCE_MS = 1_500;
const NARRATION_TIMEOUT_MS = 4_000;
const NARRATION_MAX_TOKENS = 80;
const NARRATION_MAX_CHARS = 120;
const SAID_LIMIT = 12;
/** A long turn gets a handful of updates, not a running commentary. */
const NARRATION_LIMIT = 5;

/** Rough spoken length, so the silence clock starts when a line finishes playing, not when it is written. */
export const estimateSpeechMs = (text: string): number => Math.max(1_200, text.trim().length * 80);

export interface SaidLine {
  by: "agent" | "narrator";
  text: string;
}

/** What each side of a voice turn has said aloud, so neither repeats the other. */
export class SaidLog {
  private readonly lines: SaidLine[] = [];
  /** Bumps on every addition, so a reader can tell whether it has seen the latest. */
  version = 0;
  add(by: SaidLine["by"], text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.version += 1;
    this.lines.push({ by, text: trimmed.slice(0, 400) });
    if (this.lines.length > SAID_LIMIT) this.lines.shift();
  }
  get all(): readonly SaidLine[] {
    return this.lines;
  }
  get agentSpoke(): boolean {
    return this.lines.some((line) => line.by === "agent");
  }
  /** Text for the main agent's hidden context; null while nothing has been said. */
  forAgent(): string | null {
    if (!this.lines.length) return null;
    const spoken = this.lines
      .map((line) => `- ${line.by === "agent" ? "You" : "Voice narrator"}: ${line.text}`)
      .join("\n");
    return `<system_reminder>\nThe user is on a live voice call and has already heard this during the current request:\n${spoken}\nDo not repeat it. Progress updates while you work are spoken for you by the voice narrator, so call SendToUser only for a real result, a question, or something new.\n</system_reminder>`;
  }
}

const LABELS: Record<string, string> = {
  Shell: "running a command",
  Read: "reading a file",
  Screenshot: "looking at the screen",
  WebSearch: "searching the web",
  WebFetch: "reading a web page",
  RecallMemory: "checking my memory",
  UpdateMemory: "saving a note to memory",
  Task: "handing part of this to a helper",
  CheckSubagent: "checking on a helper",
  AwaitShell: "waiting for a command to finish",
  InstallPlugin: "setting up a plugin",
  PluginCall: "using a connected service",
  CallDynamicTool: "using a tool",
  GetDynamicTools: "looking up a tool",
};

/**
 * One safe phrase per tool call. Arguments, paths, commands and results are never
 * passed on, so private content cannot reach the narration model or the speaker.
 */
export const describeAction = (toolName: string): string | null => {
  if (toolName === "SendToUser" || toolName === "ReactToMessage" || toolName === "TodoWrite")
    return null;
  return LABELS[toolName] ?? "working on it";
};

export const NARRATION_INSTRUCTIONS = [
  "You are the voice of an assistant on a live phone call. The assistant is busy working, and you say one short spoken sentence so the caller is not left in silence.",
  "Rules:",
  '- Start with "I\'m" in English, or "我正在" in Chinese, and say what is happening now. Match the language the caller used.',
  "- At most 20 words, or 25 Chinese characters. Warm and natural, like a person, never robotic or formal.",
  "- Describe only the action you are told about. Never mention tool names, file paths, commands, errors or results, and never guess the outcome.",
  '- If lines were already spoken, do not repeat their wording or idea. Vary the phrasing. A later line may begin with "Still" or "Almost" instead.',
  "- Output only the sentence. No quotes, no markdown, no emoji.",
].join("\n");

export const narrationPrompt = (input: {
  userRequest: string;
  action: string | null;
  said: readonly SaidLine[];
}): string => {
  const said = input.said.length
    ? input.said
        .map((line) => `${line.by === "agent" ? "Assistant" : "Narrator"}: ${line.text}`)
        .join("\n")
    : "(nothing yet)";
  return [
    `The caller just said: ${JSON.stringify(input.userRequest.slice(0, 500))}`,
    `Right now the assistant is: ${input.action ?? "working on it"}.`,
    `Already spoken to the caller:\n${said}`,
  ].join("\n\n");
};

export const cleanNarration = (raw: string): string | null => {
  const text = raw
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“”]+|["“”]+$/g, "")
    .trim();
  if (!text || text.length > NARRATION_MAX_CHARS * 2) return null;
  return text.slice(0, NARRATION_MAX_CHARS);
};

export interface NarratorDeps {
  infer: (request: {
    instructions: string;
    prompt: string;
    model: string;
    reasoning: PiReasoningLevel;
    timeoutMs: number;
    maxTokens: number;
    cwd: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  /** Persists the line as a chat message; the voice session then speaks it. */
  deliver: (text: string) => Promise<void>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Speaks short progress lines while the agent works. It only ever says something after
 * three seconds of silence, never while another line is being generated, and never once
 * the agent has answered after the narrator started.
 */
export class VoiceNarrator {
  readonly said = new SaidLog();
  private lastSpokeAt: number;
  private timer: unknown = null;
  private generating = false;
  private stopped = false;
  private action: string | null = null;
  private narrations = 0;
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly active: Pick<ActiveTurn, "cwd">,
    private readonly options: { model: string; reasoning: PiReasoningLevel; userRequest: string },
    private readonly deps: NarratorDeps
  ) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.lastSpokeAt = this.now();
  }

  /** A turn has started: the first line is due after the silence limit plus the acknowledgement the server speaks. */
  begin(): void {
    this.arm(NARRATION_SILENCE_MS + NARRATION_OPENING_ALLOWANCE_MS);
  }

  /** Something audible happened (an answer, or a narration), so the silence clock restarts. */
  spoke(by: SaidLine["by"], text: string): void {
    this.said.add(by, text);
    // Silence is counted from the end of the line, so the next one never queues behind it.
    const speechMs = estimateSpeechMs(text);
    this.lastSpokeAt = this.now() + speechMs;
    this.arm(speechMs + NARRATION_SILENCE_MS);
  }

  toolStarted(toolName: string): void {
    const action = describeAction(toolName);
    // Sending to the user is speech, not work; it never starts a silence countdown.
    if (!action) return;
    this.action = action;
    if (this.timer === null && !this.generating)
      this.arm(Math.max(0, NARRATION_SILENCE_MS - (this.now() - this.lastSpokeAt)));
  }

  stop(): void {
    this.stopped = true;
    this.cancelPending();
    this.controller.abort();
  }

  private cancelPending(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private arm(delayMs: number): void {
    if (this.stopped) return;
    this.cancelPending();
    this.timer = this.setTimer(
      () => {
        this.timer = null;
        void this.speak();
      },
      Math.max(0, delayMs)
    );
  }

  private async speak(): Promise<void> {
    if (this.stopped || this.generating || this.narrations >= NARRATION_LIMIT) return;
    // Less than three seconds of silence means nothing is owed yet.
    if (this.now() - this.lastSpokeAt < NARRATION_SILENCE_MS) {
      this.arm(NARRATION_SILENCE_MS - (this.now() - this.lastSpokeAt));
      return;
    }
    this.generating = true;
    const agentLinesBefore = this.said.all.filter((line) => line.by === "agent").length;
    try {
      const raw = await this.deps.infer({
        instructions: NARRATION_INSTRUCTIONS,
        prompt: narrationPrompt({
          userRequest: this.options.userRequest,
          action: this.action,
          said: this.said.all,
        }),
        model: this.options.model,
        reasoning: this.options.reasoning,
        timeoutMs: NARRATION_TIMEOUT_MS,
        maxTokens: NARRATION_MAX_TOKENS,
        cwd: this.active.cwd,
        signal: this.controller.signal,
      });
      const text = cleanNarration(raw);
      // Recheck after the model returns: the agent may have spoken in the meantime.
      const agentLinesAfter = this.said.all.filter((line) => line.by === "agent").length;
      if (!text || this.stopped || agentLinesAfter !== agentLinesBefore) return;
      this.narrations += 1;
      this.spoke("narrator", text);
      await this.deps.deliver(text);
    } catch {
      // A failed or slow narration is simply skipped; it must never disturb the turn.
    } finally {
      this.generating = false;
    }
  }
}

/** Adds the said-log to the main agent's context so it does not repeat the narrator. */
export function voiceNarrationExtension(
  narrator: VoiceNarrator,
  active: Pick<ActiveTurn, "session">
): { name: string; hidden: boolean; factory: ExtensionFactory } {
  return {
    name: "openteam-voice-narration",
    hidden: true,
    factory(pi) {
      let injectedVersion = 0;
      pi.on("context", async (event) => {
        // Messages already in the session carry earlier reminders; only a changed log adds another.
        if (narrator.said.version === injectedVersion) return undefined;
        const reminder = narrator.said.forAgent();
        if (!reminder || !active.session) return undefined;
        injectedVersion = narrator.said.version;
        // Appended after the user's message, so the request the agent works from is untouched.
        await active.session.sendCustomMessage(
          {
            customType: "openteam-voice-said",
            content: reminder,
            display: false,
            details: { origin: "host" },
          },
          { triggerTurn: false }
        );
        event.messages = [...event.messages, active.session.messages.at(-1)!];
        return undefined;
      });
    },
  };
}
