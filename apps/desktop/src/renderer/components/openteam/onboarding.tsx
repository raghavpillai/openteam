import type { ClientSnapshot, CreateBotInput } from "@openteam/contracts";
import { BOT_AVATAR_COLORS } from "@openteam/contracts/bot-avatar";
import { ROBOT_AVATAR_SHAPES, type RobotAvatarShape } from "@openteam/contracts/robot-avatar";
import type { TranscriptionSettings } from "@openteam/contracts/transcription";
import {
  RECOMMENDED_SEARCH_PROVIDER,
  SEARCH_PROVIDER_LIST,
  type WebProvidersView,
} from "@openteam/contracts/web-search";
import { Check, ChevronsUpDown, CircleAlert, Copy, Ellipsis, Minus, Shuffle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../client/openteam-api";
import { useModelSetup } from "../../hooks/use-model-setup";
import { providerName } from "../../lib/provider-names";
import {
  keyCheckMessage,
  OFFLINE_MESSAGE,
  requestErrorMessage,
  withDeadline,
} from "../../lib/request-errors";
import { requestRuntimeRefresh } from "../../lib/runtime-refresh";
import { webProviderIcon } from "../../lib/web-provider-icons";
import {
  HOSTED_TRANSCRIPTION_ENDPOINTS,
  HOSTED_TRANSCRIPTION_MODELS,
} from "../../lib/transcription-providers";
import { LoadingOrb } from "../ui/loading-orb";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { AppIcon } from "./setup/app-icons";
import { ModelPicker, modelOption } from "./setup/model-picker";
import { OpenAIMark, ProviderMark, ProviderTile } from "./setup/provider-marks";
import { changeScreen } from "./setup/screen-transition";
import { type CheckState, TopologyVisual } from "./setup/topology";
import {
  SetupCode,
  SetupLayout,
  SetupLink,
  SetupOption,
  SetupPrimary,
  SetupSuccessMark,
  SetupSwap,
  useCopied,
  useSetupKeyboard,
} from "./setup/setup-layout";
import {
  BotAvatarBadge,
  BotVisual,
  BrowserVisual,
  ChatVisual,
  KeyVisual,
  ProvidersVisual,
  SearchVisual,
  VoiceVisual,
} from "./setup/visuals";

type Runtime = ClientSnapshot["runtime"];
type Bot = ClientSnapshot["bots"][number];
type ModelSetup = ReturnType<typeof useModelSetup>;
type Screen =
  | "health"
  | "model"
  | "method"
  | "connect"
  | "key"
  | "test"
  | "search"
  | "voice"
  | "bot";
export type FirstBotProfile = Required<
  Pick<CreateBotInput, "clientRequestId" | "name" | "icon" | "color" | "description">
>;

const STAGE: Record<Screen, number> = {
  health: 0,
  model: 1,
  method: 1,
  connect: 1,
  key: 1,
  test: 1,
  search: 2,
  voice: 3,
  bot: 4,
};

const SERVER_CHECKS = [
  { key: "server", label: "Server", detail: "Answers your apps" },
  { key: "database", label: "Database", detail: "Keeps your chats and bots" },
  { key: "queue", label: "Task queue", detail: "Runs work in the background" },
  { key: "computer", label: "Bot computer", detail: "Gives bots a browser and files" },
] as const;

type AuthType = "oauth" | "api_key";

// ChatGPT and Claude each connect two ways: signing in with the plan people pay for, or a
// key for the maker's API (see MethodScreen).
const PLANS = {
  chatgpt: {
    name: "ChatGPT",
    tile: "openai",
    methods: [
      {
        providerId: "openai-codex",
        authType: "oauth",
        title: "Sign in with ChatGPT",
        detail: "Uses your ChatGPT Plus or Pro plan",
      },
      {
        providerId: "openai",
        authType: "api_key",
        title: "Use an OpenAI API key",
        detail: "Pay per use with a key from platform.openai.com",
      },
    ],
  },
  claude: {
    name: "Claude",
    tile: "anthropic",
    methods: [
      {
        providerId: "claude-code",
        authType: "oauth",
        title: "Sign in with Claude",
        detail: "Uses your Claude Pro or Max plan",
      },
      {
        providerId: "anthropic",
        authType: "api_key",
        title: "Use an Anthropic API key",
        detail: "Pay per use with a key from console.anthropic.com",
      },
    ],
  },
} as const;
type Plan = keyof typeof PLANS;

// Where each key-based provider hands out keys, and how its keys start.
const KEYS: Record<string, { keysUrl: string; prefix: string }> = {
  openai: { keysUrl: "https://platform.openai.com/api-keys", prefix: "sk-" },
  anthropic: { keysUrl: "https://console.anthropic.com/settings/keys", prefix: "sk-ant-" },
  openrouter: { keysUrl: "https://openrouter.ai/keys", prefix: "sk-or-" },
};

// The names people know: plans by their apps, APIs by their makers.
const NAMES: Record<string, string> = {
  "openai-codex": "ChatGPT",
  "claude-code": "Claude",
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
};

const ROLES = [
  {
    id: "general",
    label: "General helper",
    description: "Helps with research, writing, and everyday tasks on the web.",
    greeting: "I can research, write, and take care of tasks on the web. What's first?",
  },
  {
    id: "research",
    label: "Researcher",
    description: "Finds, compares, and summarizes information from the web, with sources.",
    greeting:
      "I find, compare, and summarize what's out there, with sources. What should we dig into?",
  },
  {
    id: "inbox",
    label: "Inbox assistant",
    description: "Sorts email, drafts replies for your review, and tracks follow-ups.",
    greeting:
      "I'll sort your email and draft replies for you to check. Want to connect your inbox?",
  },
  {
    id: "writer",
    label: "Writer",
    description: "Drafts and edits documents, posts, and messages in your voice.",
    greeting:
      "I draft and polish documents, posts, and messages in your voice. What are we writing?",
  },
  {
    id: "ops",
    label: "Operations",
    description: "Handles recurring admin work like reports, spreadsheets, and checklists.",
    greeting:
      "I handle the recurring admin: reports, spreadsheets, checklists. What's on your plate?",
  },
] as const;

const BOT_NAMES = ["Atlas", "Nova", "Juniper", "Pixel", "Sage", "Orbit"] as const;
const AVATAR_COLORS = BOT_AVATAR_COLORS.filter(
  (color) => color !== "#242424" && color !== "#878787"
);

const pick = <T,>(values: readonly T[]): T =>
  values[Math.floor(Math.random() * values.length)] as T;
const randomAvatar = () => ({
  shape: pick(ROBOT_AVATAR_SHAPES) as RobotAvatarShape,
  color: pick(AVATAR_COLORS),
});

// Named from the server's provider list, not the provider loaded last.
const providerTitle = (id: string, setup: ModelSetup) =>
  NAMES[id] ?? providerName(id, setup.data?.providers.find((provider) => provider.id === id)?.name);

const openExternal = (url: string) => window.open(url, "_blank", "noopener,noreferrer");

/** True once `active` has stayed true for `ms`: long enough to say it's still going. */
function useTakingLong(active: boolean, ms = 20_000) {
  const [long, setLong] = useState(false);
  useEffect(() => {
    setLong(false);
    if (!active) return;
    const timer = window.setTimeout(() => setLong(true), ms);
    return () => window.clearTimeout(timer);
  }, [active, ms]);
  return active && long;
}

// Screens that run by themselves or start a sign-in; Back never replays them.
const TRANSIENT: ReadonlySet<Screen> = new Set(["health", "connect", "test"]);

type Frame = {
  stage: number;
  screenKey: string;
  direction: "forward" | "back";
  onBack?: () => void;
};

/** First run after sign-in: server check, AI model, web search, voice notes, and a first bot. */
export function Onboarding({
  runtime,
  bots,
  onCreateBot,
  onOpenBot,
  onFinish,
}: {
  runtime: Runtime;
  /** The server's bots, kept current, so one made on another device during setup shows up. */
  bots: readonly Bot[];
  /** Resolves once the bot exists; a rejection keeps the wizard open to retry. */
  onCreateBot: (profile: FirstBotProfile) => Promise<void>;
  /** Opens a bot that already exists (one just made on another device) and closes setup. */
  onOpenBot: (bot: Bot) => Promise<void>;
  onFinish: () => void;
}) {
  const setup = useModelSetup();
  // The bots the server had when setup opened. Whether it had any is decided then: the bot
  // created on the last screen must not switch that screen to "You're all set" while it is
  // being made. Bots that turn up later are shown to the bot screen as arrivals.
  const [initialBots] = useState(() => new Set(bots.map((bot) => bot.id)));
  const arrivals = useMemo(
    () => bots.filter((bot) => !initialBots.has(bot.id)),
    [bots, initialBots]
  );
  const [screen, setScreen] = useState<Screen>("health");
  const [history, setHistory] = useState<Screen[]>([]);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [providerChoice, setProviderChoice] = useState("openai-codex");
  const [plan, setPlan] = useState<Plan>("chatgpt");
  // An OpenAI key can also turn on voice notes; it stays in memory for this run only.
  const openAIKey = useRef<string | null>(null);
  const voiceConfigured = runtime.transcription === "configured";
  // The server's web providers, read up front so a server that already searches skips that step.
  const [webProviders, setWebProviders] = useState<WebProvidersView | null>(null);
  useEffect(() => {
    let active = true;
    api
      .webProviders()
      .then((view) => active && setWebProviders(view))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const searchConfigured = Boolean(webProviders?.search.selected);

  // Every screen change runs as a view transition (see setup/screen-transition.ts). The
  // update lands a frame later, so a repeat request for the same screen is dropped.
  const leaving = useRef<Screen | null>(null);
  const go = (next: Screen, before?: () => void) => {
    if (leaving.current === next) return;
    leaving.current = next;
    changeScreen(() => {
      leaving.current = null;
      before?.();
      setDirection("forward");
      setHistory((previous) => {
        const kept = TRANSIENT.has(screen) ? previous : [...previous, screen];
        // Going to a screen already in the history rewinds to it instead of looping.
        const index = kept.lastIndexOf(next);
        return index >= 0 ? kept.slice(0, index) : kept;
      });
      setScreen(next);
    });
  };
  const back = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setup.cancelSignIn();
    changeScreen(() => {
      setDirection("back");
      setHistory((entries) => entries.slice(0, -1));
      setScreen(previous);
    }, "back");
  };
  const afterSearch = () => go(voiceConfigured ? "bot" : "voice");
  // A passing test closes the model steps, so Back from here returns to the model choice.
  const afterModel = () =>
    go(searchConfigured ? (voiceConfigured ? "bot" : "voice") : "search", () =>
      setHistory((previous) => previous.filter((entry) => entry !== "key" && entry !== "method"))
    );
  const connectWith = (providerId: string, authType: AuthType) =>
    go(authType === "api_key" ? "key" : "connect", () => setProviderChoice(providerId));

  useSetupKeyboard(history.length ? back : undefined);

  const frame: Frame = {
    stage: STAGE[screen],
    screenKey: screen,
    direction,
    onBack: history.length ? back : undefined,
  };
  if (screen === "health") {
    return <HealthScreen frame={frame} onContinue={() => go("model")} />;
  }
  if (screen === "model") {
    return (
      <ModelScreen
        frame={frame}
        onChoose={connectWith}
        onChoosePlan={(next) => go("method", () => setPlan(next))}
        onKeep={afterModel}
        onSignInAgain={(providerId) => go("connect", () => setProviderChoice(providerId))}
        onSkip={onFinish}
        setup={setup}
      />
    );
  }
  if (screen === "method") {
    return <MethodScreen frame={frame} onChoose={connectWith} plan={plan} />;
  }
  if (screen === "connect") {
    return (
      <ConnectScreen
        frame={frame}
        onConnected={() => go("test")}
        providerId={providerChoice}
        setup={setup}
      />
    );
  }
  if (screen === "key") {
    return (
      <KeyScreen
        frame={frame}
        onConnected={(key) => {
          openAIKey.current = providerChoice === "openai" ? key : null;
          go("test");
        }}
        providerId={providerChoice}
        setup={setup}
      />
    );
  }
  if (screen === "test") {
    return (
      <TestScreen
        frame={frame}
        onChooseAnother={() => go("model")}
        onContinue={afterModel}
        onSignInAgain={() => go("connect", () => setProviderChoice(setup.providerId))}
        setup={setup}
      />
    );
  }
  if (screen === "search") {
    return (
      <SearchScreen
        frame={frame}
        initial={webProviders}
        onDone={(view) => {
          setWebProviders(view);
          afterSearch();
        }}
        onSkip={afterSearch}
      />
    );
  }
  if (screen === "voice") {
    return (
      <VoiceScreen
        frame={frame}
        onDone={() => go("bot")}
        onSkip={() => go("bot")}
        openAIKey={openAIKey.current}
      />
    );
  }
  return (
    <BotScreen
      arrivals={arrivals}
      frame={frame}
      hasBots={initialBots.size > 0}
      onCreateBot={onCreateBot}
      onFinish={onFinish}
      onOpenBot={onOpenBot}
    />
  );
}

/**
 * The server check as it first looks, before anything is known: what the first-run frame
 * shows while the app reloads after sign-in and loads the server (first-run-shell.tsx). The
 * real check then picks up from it without moving. With a `problem` the server couldn't be
 * loaded: the check says so and Check again runs `onRetry`.
 */
export function ServerCheckPreview({
  problem = null,
  onRetry,
  retrying = false,
}: {
  problem?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <HealthScreen
      frame={{ stage: 0, screenKey: "health", direction: "forward" }}
      onContinue={() => {}}
      onRetry={onRetry}
      preview
      problem={problem}
      retrying={retrying}
    />
  );
}

// How long one look at the server may take before it counts as no answer.
const HEALTH_DEADLINE_MS = 10_000;
const UNREACHABLE =
  "Check that your server is on and that this computer is online. We'll keep trying.";

function HealthScreen({
  frame,
  onContinue,
  preview = false,
  problem = null,
  onRetry,
  retrying = false,
}: {
  frame: Frame;
  onContinue: () => void;
  /** Rows wait with spinners; nothing is checked yet (see ServerCheckPreview). */
  preview?: boolean;
  /** Why the server couldn't be loaded, shown in place of the check. */
  problem?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const [revealed, setRevealed] = useState(0);
  const [stuck, setStuck] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The server's own answer, asked for on arrival and every few seconds until everything is
  // up. The app's copy can be stale (this computer may have just gone offline), and a
  // request that fails counts as not ready.
  const [answer, setAnswer] = useState<{ runtime: Runtime } | { unreachable: true } | null>(null);
  const runtime = answer && "runtime" in answer ? answer.runtime : null;
  const unreachable = Boolean(problem) || Boolean(answer && "unreachable" in answer);
  // The server reports "degraded" when any part is down, but it answered, so its own row passes.
  const ready = SERVER_CHECKS.map(
    (check) => runtime !== null && (check.key === "server" || runtime[check.key] === "ready")
  );
  const allReady = ready.every(Boolean);
  const done = allReady && revealed >= SERVER_CHECKS.length;
  const continueRef = useRef(onContinue);
  continueRef.current = onContinue;

  // Rows tick one after another so the check reads as work being done.
  useEffect(() => {
    if (preview || revealed >= SERVER_CHECKS.length) return;
    const timer = window.setTimeout(() => setRevealed((count) => count + 1), 320);
    return () => window.clearTimeout(timer);
  }, [preview, revealed]);

  useEffect(() => {
    if (preview || allReady) return;
    let active = true;
    let next: number | undefined;
    const look = async () => {
      try {
        const view = await withDeadline((signal) => api.runtime(signal), HEALTH_DEADLINE_MS);
        if (active) setAnswer({ runtime: view.runtime });
      } catch {
        if (active) setAnswer({ unreachable: true });
      }
      if (active) next = window.setTimeout(look, 3_000);
    };
    void look();
    // Check again gets a shorter wait: the slow first start is already over.
    const giveUp = window.setTimeout(() => setStuck(true), attempt ? 6_000 : 15_000);
    return () => {
      active = false;
      window.clearTimeout(next);
      window.clearTimeout(giveUp);
    };
  }, [allReady, attempt, preview]);

  // The rest of the app catches up with what the check just saw.
  useEffect(() => {
    if (allReady) requestRuntimeRefresh();
  }, [allReady]);

  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => continueRef.current(), 1_000);
    return () => window.clearTimeout(timer);
  }, [done]);

  const failing = Boolean(problem) || (stuck && !allReady);
  const lost = failing && unreachable;
  const states = SERVER_CHECKS.map((_, index): CheckState => {
    // Nothing is known about the parts behind a server that doesn't answer.
    if (lost) return index === 0 ? "failed" : "blocked";
    if (index >= revealed) return "pending";
    return ready[index] ? "ready" : failing ? "failed" : "pending";
  });
  // The title already says the server can't be reached; the body says what to check.
  const lostBody = problem && problem !== OFFLINE_MESSAGE ? problem : UNREACHABLE;
  return (
    <SetupLayout
      {...frame}
      body={
        lost ? (
          lostBody
        ) : failing ? (
          <>
            Run <code>openteam doctor</code> on your server to see why.
          </>
        ) : done ? (
          "Your server is ready for bots."
        ) : (
          "This takes a few seconds."
        )
      }
      footer={
        failing ? (
          <>
            <SetupPrimary busy={retrying}>Check again</SetupPrimary>
            {lost || preview ? null : <SetupLink onClick={onContinue}>Continue anyway</SetupLink>}
          </>
        ) : null
      }
      onSubmit={
        !failing
          ? undefined
          : preview
            ? onRetry
            : () => {
                setStuck(false);
                setAttempt((count) => count + 1);
              }
      }
      title={
        done
          ? "All systems go"
          : lost
            ? "Can't reach your server"
            : failing
              ? "Something isn't running yet"
              : "Checking your server"
      }
      tone={failing ? "error" : undefined}
      visual={<TopologyVisual states={states} unreachable={lost} />}
    >
      <ul className="setup-check-list">
        {SERVER_CHECKS.map((check, index) => (
          <li data-state={states[index]} key={check.key}>
            <span className="setup-check-icon">
              {states[index] === "ready" ? (
                <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
              ) : states[index] === "failed" ? (
                <CircleAlert aria-hidden="true" className="size-3.5" />
              ) : states[index] === "blocked" ? (
                <Minus aria-hidden="true" className="size-3.5" />
              ) : (
                <LoadingOrb aria-hidden size={14} />
              )}
            </span>
            <span>
              <strong>{check.label}</strong>
              <small>{check.detail}</small>
            </span>
          </li>
        ))}
      </ul>
    </SetupLayout>
  );
}

function ModelScreen({
  frame,
  setup,
  onChoose,
  onChoosePlan,
  onKeep,
  onSignInAgain,
  onSkip,
}: {
  frame: Frame;
  setup: ModelSetup;
  onChoose: (providerId: string, authType: AuthType) => void;
  onChoosePlan: (plan: Plan) => void;
  onKeep: () => void;
  onSignInAgain: (providerId: string) => void;
  onSkip: () => void;
}) {
  const [changing, setChanging] = useState(false);
  // A model picked here is saved and tested again before Keep it.
  const [picked, setPicked] = useState(false);
  const [retest, setRetest] = useState(false);
  const tested = useRef(false);
  const saved = setup.data?.inference.modelId ? setup.data.inference : null;
  const slow = useTakingLong(Boolean(saved) && !changing && setup.test.status === "running");

  // A model saved earlier (for example by the CLI) gets one real test first.
  useEffect(() => {
    if (tested.current || !saved || setup.busy || setup.test.status !== "idle") return;
    tested.current = true;
    // Back from another provider restores the saved provider's catalog and selection too.
    void setup.selectProvider(saved.providerId).then(() => setup.runTest(saved.providerId));
  }, [saved, setup]);

  useEffect(() => {
    if (!retest || setup.busy) return;
    setRetest(false);
    void setup.apply();
  }, [retest, setup]);

  // Settings first load during the server check; if a part was still down then, load again.
  // A load still running when this screen opens is current, so its failure shows as is.
  const reloaded = useRef(setup.busy === "load");
  useEffect(() => {
    if (setup.data || setup.busy || reloaded.current) return;
    reloaded.current = true;
    void setup.reload();
  }, [setup]);

  const others = (setup.data?.providers ?? []).filter((provider) => !NAMES[provider.id]);
  // Asked for a different AI while the saved one works: Back (or Esc) keeps it after all.
  const keepSaved =
    saved && changing && setup.test.status === "passed" && !frame.onBack
      ? () => changeScreen(() => setChanging(false), "back")
      : undefined;
  useSetupKeyboard(keepSaved);

  if (!setup.data) {
    const failed = Boolean(setup.error) && !setup.busy && reloaded.current;
    return (
      <SetupLayout
        {...frame}
        body={failed ? setup.error : "Loading your server's AI settings…"}
        footer={
          failed ? (
            <>
              <SetupPrimary>Try again</SetupPrimary>
              <SetupLink onClick={onSkip}>
                Skip for now — bots can't reply until you connect one
              </SetupLink>
            </>
          ) : null
        }
        onSubmit={() => void setup.reload()}
        title={failed ? "Couldn't load your AI settings" : "Checking your AI"}
        visual={<ProvidersVisual />}
      />
    );
  }

  if (saved && !changing) {
    const test = setup.test;
    const name = providerTitle(saved.providerId, setup);
    const modelName = setup.selectedModel
      ? modelOption(setup.selectedModel, "").name
      : saved.modelId;
    const testing = test.status === "running" || test.status === "idle" || retest;
    // The saved provider's models, in its catalog's order; picking one tests it.
    const picker =
      setup.data.models.length > 1 && setup.providerId === saved.providerId ? (
        <>
          <span className="setup-label">Model</span>
          <ModelPicker
            disabled={testing || Boolean(setup.busy)}
            models={setup.data.models}
            onChange={(modelId) => {
              setup.selectModel(modelId);
              setPicked(true);
              setRetest(true);
            }}
            providerName={name}
            value={setup.modelId}
          />
        </>
      ) : null;

    // The check failed: the failure, with Try again. Choosing another AI is there too, but
    // only when asked for: a blip, a restart or a rate limit passes.
    if (test.status === "failed" && !retest) {
      const plan = setup.data.providers
        .find((provider) => provider.id === saved.providerId)
        ?.authMethods.some((method) => method.type === "oauth");
      return (
        <SetupLayout
          {...frame}
          body={test.error}
          footer={
            <>
              <SetupPrimary>Try again</SetupPrimary>
              {plan ? (
                <SetupLink onClick={() => onSignInAgain(saved.providerId)}>
                  Sign in to {name} again
                </SetupLink>
              ) : null}
              <SetupLink onClick={() => changeScreen(() => setChanging(true))}>
                Choose a different AI
              </SetupLink>
            </>
          }
          // A model picked here that couldn't be saved is saved again; otherwise the saved
          // one is tested again.
          onSubmit={() => (setup.changed ? setRetest(true) : void setup.runTest())}
          title="That didn't work"
          tone="error"
          visual={
            <ChatVisual
              error="No reply"
              modelName={modelName}
              phase="failed"
              providerId={saved.providerId}
              providerName={name}
            />
          }
        >
          {picker}
        </SetupLayout>
      );
    }

    return (
      <SetupLayout
        {...frame}
        body={
          !testing
            ? `${name} · ${modelName} is connected and replying.`
            : slow
              ? `Still waiting for ${modelName} to answer. Some take up to a minute.`
              : picked
                ? `Sending a short test message to ${modelName}…`
                : "Checking the AI your server already uses…"
        }
        footer={
          <>
            <SetupPrimary busy={testing}>Keep it</SetupPrimary>
            <SetupLink onClick={() => changeScreen(() => setChanging(true))}>
              Use a different AI
            </SetupLink>
          </>
        }
        onSubmit={() => test.status === "passed" && !retest && onKeep()}
        title={!testing ? "You're already connected" : "Checking your AI"}
        visual={
          <ChatVisual
            latencyMs={test.status === "passed" ? test.latencyMs : undefined}
            modelName={modelName}
            phase={testing ? "testing" : "passed"}
            providerId={saved.providerId}
            providerName={name}
          />
        }
      >
        {picker}
      </SetupLayout>
    );
  }

  return (
    <SetupLayout
      {...frame}
      body="Sign in with a ChatGPT or Claude plan you already pay for, or use an API key."
      footer={
        keepSaved ? null : (
          <SetupLink onClick={onSkip}>
            Skip for now — bots can't reply until you connect one
          </SetupLink>
        )
      }
      onBack={frame.onBack ?? keepSaved}
      title="Choose your bots' AI"
      visual={<ProvidersVisual />}
    >
      <SetupOption
        detail="Your ChatGPT plan or an OpenAI API key"
        icon={<AppIcon app="chatgpt" size={40} />}
        onClick={() => onChoosePlan("chatgpt")}
        title="ChatGPT"
      />
      <SetupOption
        detail="Your Claude plan or an Anthropic API key"
        icon={<AppIcon app="claude" size={40} />}
        onClick={() => onChoosePlan("claude")}
        title="Claude"
      />
      <SetupOption
        detail="One key, hundreds of models"
        icon={<ProviderTile provider="openrouter" size={40} />}
        onClick={() => onChoose("openrouter", "api_key")}
        title="OpenRouter"
      />
      {others.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="setup-option" type="button">
              <span className="setup-option-icon">
                <span className="setup-more-tile">
                  <Ellipsis aria-hidden="true" className="size-5" strokeWidth={2.5} />
                </span>
              </span>
              <span className="setup-option-text">
                <strong>More providers</strong>
                <span>OpenAI-compatible endpoints</span>
              </span>
              <ChevronsUpDown aria-hidden="true" className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-[var(--radix-dropdown-menu-trigger-width)]"
          >
            {others.map((provider) => (
              <DropdownMenuItem
                key={provider.id}
                onSelect={() => onChoose(provider.id, provider.authMethods[0]?.type ?? "api_key")}
              >
                {provider.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </SetupLayout>
  );
}

/** ChatGPT and Claude: sign in with the plan, or use a key for the maker's API. */
function MethodScreen({
  frame,
  plan,
  onChoose,
}: {
  frame: Frame;
  plan: Plan;
  onChoose: (providerId: string, authType: AuthType) => void;
}) {
  const { name, tile, methods } = PLANS[plan];
  return (
    <SetupLayout
      {...frame}
      body={`Sign in with the ${name} plan you already pay for, or use an API key.`}
      title={`Connect ${name}`}
      visual={<ProvidersVisual focus={plan} />}
    >
      {methods.map((method) => (
        <SetupOption
          detail={method.detail}
          icon={
            method.authType === "oauth" ? (
              <AppIcon app={plan} size={40} />
            ) : (
              <ProviderTile provider={tile} size={40} />
            )
          }
          key={method.providerId}
          onClick={() => onChoose(method.providerId, method.authType)}
          title={method.title}
        />
      ))}
    </SetupLayout>
  );
}

function ConnectScreen({
  frame,
  setup,
  providerId,
  onConnected,
}: {
  frame: Frame;
  setup: ModelSetup;
  providerId: string;
  onConnected: () => void;
}) {
  const started = useRef(false);
  const copied = useRef<string | null>(null);
  const [value, setValue] = useState("");
  // Only the sign-in this screen started counts. One left over from an earlier attempt
  // (say, a "connected" one whose test then failed) must not skip the sign-in.
  const [ownId, setOwnId] = useState<string | null>(null);
  const session = setup.authSession?.id === ownId ? setup.authSession : null;
  const name = providerTitle(providerId, setup);
  const connectedRef = useRef(onConnected);
  connectedRef.current = onConnected;
  const [codeCopied, copyCode] = useCopied();
  const [linkCopied, copyLink] = useCopied();

  useEffect(() => {
    void setup.selectProvider(providerId);
  }, [providerId]);

  const start = () => {
    started.current = true;
    setOwnId(null);
    setValue("");
    const oauth = setup.provider?.authMethods.some((method) => method.type === "oauth");
    void setup
      .cancelSignIn()
      .then(() => setup.connect(oauth ? "oauth" : undefined))
      .then((next) => setOwnId(next?.id ?? null));
  };

  // Start the sign-in once this provider's details are loaded.
  useEffect(() => {
    if (started.current || setup.provider?.id !== providerId || setup.busy) return;
    start();
  }, [providerId, setup]);

  // A device code is copied right away so it can be pasted on the sign-in page.
  useEffect(() => {
    const code = session?.deviceCode?.userCode;
    if (!code || copied.current === code) return;
    copied.current = code;
    void navigator.clipboard?.writeText(code).catch(() => {});
  }, [session?.deviceCode?.userCode]);

  const connected = session?.status === "connected" && setup.provider?.connected;
  useEffect(() => {
    if (!connected) return;
    const timer = window.setTimeout(() => connectedRef.current(), 900);
    return () => window.clearTimeout(timer);
  }, [connected]);

  const prompt = session?.prompt;
  const waitingForBrowser = setup.capture === "waiting" && Boolean(session?.authorizationUrl);
  const pasting = prompt?.type === "manual_code" && !waitingForBrowser;
  const visual = (
    <BrowserVisual
      code={session?.deviceCode?.userCode}
      paste={pasting}
      provider={name}
      providerId={providerId}
      signedIn={Boolean(connected)}
    />
  );
  if (connected) {
    return (
      <SetupLayout
        {...frame}
        body={`${name} is connected. Next, a quick test.`}
        title="Signed in"
        visual={visual}
      >
        <SetupSuccessMark />
      </SetupLayout>
    );
  }
  if (
    session?.status === "failed" ||
    session?.status === "cancelled" ||
    (setup.error && !session && !setup.busy)
  ) {
    return (
      <SetupLayout
        {...frame}
        body={session?.error || setup.error || "The sign-in was cancelled."}
        footer={<SetupPrimary>Try again</SetupPrimary>}
        onSubmit={start}
        title="That didn't work"
        tone="error"
        visual={visual}
      />
    );
  }
  if (session?.deviceCode) {
    const { userCode, verificationUri } = session.deviceCode;
    return (
      <SetupLayout
        {...frame}
        body="Open the sign-in page and type this code. It's already copied. We'll continue automatically."
        footer={
          <>
            <SetupPrimary>Open sign-in page</SetupPrimary>
            <SetupLink onClick={() => copyCode(userCode)}>
              <SetupSwap
                active={codeCopied}
                off={
                  <>
                    <Copy aria-hidden="true" className="inline size-3.5" /> Copy code again
                  </>
                }
                on={
                  <>
                    <Check aria-hidden="true" className="inline size-3.5" /> Copied
                  </>
                }
              />
            </SetupLink>
          </>
        }
        onSubmit={() => openExternal(verificationUri)}
        title="Enter this code to sign in"
        visual={visual}
      >
        <SetupCode code={userCode} />
      </SetupLayout>
    );
  }
  if (prompt && prompt.type !== "select" && !(prompt.type === "manual_code" && waitingForBrowser)) {
    return (
      <SetupLayout
        {...frame}
        body={
          prompt.type === "manual_code"
            ? `${setup.captureMessage ?? ""} After you sign in, copy the address your browser lands on and paste it here.`.trim()
            : prompt.message
        }
        footer={
          <>
            <SetupPrimary busy={setup.busy === "respond"} disabled={!value.trim()}>
              Continue
            </SetupPrimary>
            {session?.authorizationUrl ? (
              <SetupLink onClick={() => openExternal(session.authorizationUrl!)}>
                Open the sign-in page
              </SetupLink>
            ) : null}
          </>
        }
        onSubmit={() => void setup.respond(prompt.id, value.trim())}
        title="Finish signing in in your browser"
        visual={visual}
      >
        <input
          aria-label={prompt.message}
          autoComplete="off"
          // biome-ignore lint/a11y/noAutofocus: Pasting the address is the only thing left to do.
          autoFocus
          className="setup-input"
          onChange={(event) => setValue(event.target.value)}
          placeholder={
            prompt.type === "manual_code" ? "Paste the address from your browser" : prompt.message
          }
          type={prompt.type === "secret" ? "password" : "text"}
          value={value}
        />
      </SetupLayout>
    );
  }
  return (
    <SetupLayout
      {...frame}
      body={
        waitingForBrowser ? "We'll bring you back here automatically." : `Opening ${name} sign-in…`
      }
      footer={
        waitingForBrowser && session?.authorizationUrl ? (
          <div className="setup-row">
            <button
              className="setup-secondary"
              onClick={() => openExternal(session.authorizationUrl!)}
              type="button"
            >
              Open it again
            </button>
            <button
              className="setup-secondary"
              onClick={() => copyLink(session.authorizationUrl!)}
              type="button"
            >
              <SetupSwap active={linkCopied} off="Copy link" on="Copied" />
            </button>
          </div>
        ) : null
      }
      title={waitingForBrowser ? "Finish signing in in your browser" : `Connecting ${name}`}
      visual={visual}
    >
      <p className="setup-note">
        <span className="mr-1.5 inline-flex align-[-2px]">
          <LoadingOrb aria-hidden size={14} />
        </span>
        {waitingForBrowser ? `Waiting for ${name}…` : "Starting sign-in…"}
      </p>
    </SetupLayout>
  );
}

function KeyScreen({
  frame,
  setup,
  providerId,
  onConnected,
}: {
  frame: Frame;
  setup: ModelSetup;
  providerId: string;
  onConnected: (key: string) => void;
}) {
  const [key, setKey] = useState("");
  // One per Connect; a newer one (or a new key) makes an older one's late answers stale.
  const [request, setRequest] = useState<{ id: number; key: string } | null>(null);
  const [step, setStep] = useState<"connecting" | "checking" | "testing">("connecting");
  const [rejected, setRejected] = useState<string | null>(null);
  const requests = useRef(0);
  const answered = useRef<string | null>(null);
  const started = useRef<number | null>(null);
  const checked = useRef<number | null>(null);
  const keyInfo = KEYS[providerId];
  const label = providerTitle(providerId, setup);
  const session = setup.authSession;
  const connectedRef = useRef(onConnected);
  connectedRef.current = onConnected;

  // Load the provider, then start one key sign-in per Connect. A sign-in that can't start
  // shows its error rather than being retried.
  useEffect(() => {
    if (!request || setup.busy || started.current === request.id) return;
    if (setup.provider?.id !== providerId) {
      void setup.selectProvider(providerId);
    } else {
      started.current = request.id;
      setStep("connecting");
      void setup.connect("api_key");
    }
  }, [request, setup]);

  // The provider asks for the key as a prompt; answer it with what was pasted.
  useEffect(() => {
    const prompt = session?.prompt;
    if (!request || !prompt || prompt.type !== "secret" || answered.current === prompt.id) return;
    answered.current = prompt.id;
    void setup.respond(prompt.id, request.key);
  }, [request, session?.prompt?.id]);

  // A connected key is checked before going on: the provider must list its models for it,
  // and then answer a real test message. A key it refuses stays here with the reason.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once per connected request.
  useEffect(() => {
    if (!request || session?.status !== "connected" || checked.current === request.id) return;
    checked.current = request.id;
    const current = () => requests.current === request.id;
    const refuse = (message: string) => {
      setRejected(message);
      setRequest(null);
    };
    void (async () => {
      setStep("checking");
      const loaded = await setup.loadProvider(providerId);
      if (!current()) return;
      if ("error" in loaded) return refuse(loaded.error);
      if (!loaded.data.models.length || !loaded.selection.modelId) {
        const row = loaded.data.providers.find((provider) => provider.id === providerId);
        // A key the provider refused isn't left saved on the server.
        void api.disconnectInferenceProvider(providerId).catch(() => {});
        return refuse(keyCheckMessage(row?.modelMessage ?? "", label));
      }
      setStep("testing");
      const outcome = await setup.apply(loaded.selection);
      if (!current()) return;
      if (outcome.status === "failed" && outcome.rejected) {
        return refuse(keyCheckMessage("401", label));
      }
      // Passed, or failed for a reason the next screen offers to try again.
      connectedRef.current(request.key);
    })();
  }, [request, session?.status]);

  const failure = request
    ? session?.status === "failed"
      ? keyCheckMessage(session.error ?? "", label)
      : (setup.error ?? null)
    : rejected;
  const busy = Boolean(request) && !failure;
  const progress =
    step === "connecting"
      ? `Connecting to ${label}…`
      : step === "checking"
        ? `Checking your key with ${label}…`
        : `Sending a test message to ${
            setup.selectedModel ? modelOption(setup.selectedModel, label).name : label
          }…`;
  return (
    <SetupLayout
      {...frame}
      body={`Your server checks it with ${label}, then keeps it there.`}
      footer={
        <>
          <SetupPrimary busy={busy} disabled={!key.trim()}>
            Connect
          </SetupPrimary>
          {keyInfo ? (
            <SetupLink onClick={() => openExternal(keyInfo.keysUrl)}>
              Get a key from {label}
            </SetupLink>
          ) : null}
        </>
      }
      onSubmit={() => {
        const value = key.trim();
        if (!value || busy) return;
        answered.current = null;
        setRejected(null);
        // Stops any earlier attempt on the server; the server allows one per provider.
        void setup.cancelSignIn();
        requests.current += 1;
        setRequest({ id: requests.current, key: value });
      }}
      title={
        providerId === "openrouter" ? "Paste your OpenRouter key" : `Paste your ${label} API key`
      }
      visual={<KeyVisual prefix={keyInfo?.prefix ?? ""} provider={label} providerId={providerId} />}
    >
      <input
        aria-invalid={Boolean(failure)}
        aria-label="API key"
        autoComplete="off"
        // biome-ignore lint/a11y/noAutofocus: The key field is the only input on this screen.
        autoFocus
        className="setup-input"
        onChange={(event) => {
          setKey(event.target.value);
          setRejected(null);
          requests.current += 1;
          setRequest(null);
        }}
        placeholder={keyInfo ? `${keyInfo.prefix}…` : "API key"}
        readOnly={busy}
        spellCheck={false}
        type="password"
        value={key}
      />
      {failure ? (
        <p className="setup-note" data-tone="error" role="alert">
          {failure}
        </p>
      ) : busy ? (
        <p className="setup-note">
          <span className="mr-1.5 inline-flex align-[-2px]">
            <LoadingOrb aria-hidden size={14} />
          </span>
          {progress}
        </p>
      ) : null}
    </SetupLayout>
  );
}

function TestScreen({
  frame,
  setup,
  onContinue,
  onChooseAnother,
  onSignInAgain,
}: {
  frame: Frame;
  setup: ModelSetup;
  onContinue: () => void;
  onChooseAnother: () => void;
  onSignInAgain: () => void;
}) {
  // A key arrives already tested (see KeyScreen); a sign-in still needs its test.
  const [pending, setPending] = useState(() => setup.test.status === "idle" || setup.changed);

  // Save the provider's default model and send the real test as soon as the screen
  // opens, and again whenever a different model is picked.
  useEffect(() => {
    if (!pending || setup.busy || !setup.modelId) return;
    setPending(false);
    void setup.apply();
  }, [pending, setup]);

  const test = setup.test;
  // Try again shows the test running at once, not the old failure until the save is done.
  const retrying = pending || setup.busy === "save";
  const slow = useTakingLong(test.status === "running" || retrying);
  // "OpenRouter: Auto Router" reads as "Auto Router"; the maker shows in the picker.
  const modelName = setup.selectedModel ? modelOption(setup.selectedModel, "").name : setup.modelId;
  const noModels = !setup.modelId && !setup.busy && Boolean(setup.data);
  if (noModels || (test.status === "failed" && !retrying)) {
    // No model list usually means the provider refused the key or sign-in.
    const message = noModels ? (setup.provider?.modelMessage ?? "") : "";
    const rejected = /\b(401|403)\b/.test(message);
    const name = providerTitle(setup.providerId, setup);
    const body =
      test.status === "failed"
        ? test.error
        : rejected
          ? `${name} didn't accept that. Check your key or sign in again.`
          : message || "This account doesn't offer any chat models.";
    // A plan sign-in can expire; signing in again is the usual fix.
    const signsIn =
      setup.provider?.authType !== "api_key" &&
      Boolean(setup.provider?.authMethods.some((method) => method.type === "oauth"));
    return (
      <SetupLayout
        {...frame}
        body={body}
        footer={
          <>
            <SetupPrimary>Try again</SetupPrimary>
            {signsIn ? (
              <SetupLink onClick={onSignInAgain}>Sign in to {name} again</SetupLink>
            ) : null}
            <SetupLink onClick={onChooseAnother}>Choose a different AI</SetupLink>
          </>
        }
        onSubmit={noModels ? (frame.onBack ?? onChooseAnother) : () => setPending(true)}
        title="That didn't work"
        tone="error"
        visual={
          <ChatVisual
            error="No reply"
            modelName={modelName || name}
            phase="failed"
            providerId={setup.providerId}
            providerName={name}
          />
        }
      />
    );
  }
  const passed = test.status === "passed" && !retrying;
  return (
    <SetupLayout
      {...frame}
      body={
        passed
          ? `${modelName} answered your server's test message.`
          : slow
            ? `Still waiting for ${modelName || "your AI"} to answer. Some take up to a minute.`
            : `Sending a short test message to ${modelName || "your AI"}…`
      }
      celebrate={passed}
      footer={<SetupPrimary busy={!passed}>Continue</SetupPrimary>}
      onSubmit={() => passed && onContinue()}
      title={passed ? "It works!" : "Let's make sure it works"}
      visual={
        <ChatVisual
          celebrate={passed}
          latencyMs={test.status === "passed" ? test.latencyMs : undefined}
          modelName={modelName}
          phase={passed ? "passed" : "testing"}
          providerId={setup.providerId}
          providerName={providerTitle(setup.providerId, setup)}
        />
      }
    >
      {setup.data && setup.data.models.length > 1 ? (
        <>
          <span className="setup-label">Model</span>
          <ModelPicker
            disabled={!passed}
            models={setup.data.models}
            onChange={(modelId) => {
              setup.selectModel(modelId);
              setPending(true);
            }}
            providerName={providerTitle(setup.providerId, setup)}
            value={setup.modelId}
          />
        </>
      ) : null}
    </SetupLayout>
  );
}

const searchInfo = (id: string) =>
  SEARCH_PROVIDER_LIST.find((provider) => provider.id === id) ?? SEARCH_PROVIDER_LIST[0];

/**
 * Web search: one provider, recommended first, checked with a real search before it counts.
 * A key that fails its check leaves search off, so bots never claim a search they can't run.
 */
function SearchScreen({
  frame,
  initial,
  onDone,
  onSkip,
}: {
  frame: Frame;
  initial: WebProvidersView | null;
  onDone: (view: WebProvidersView) => void;
  onSkip: () => void;
}) {
  const [view, setView] = useState(initial);
  const [providerId, setProviderId] = useState<string>(RECOMMENDED_SEARCH_PROVIDER);
  const [key, setKey] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const info = searchInfo(providerId);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const skipRef = useRef(onSkip);
  skipRef.current = onSkip;

  useEffect(() => {
    if (view) return;
    let active = true;
    api
      .webProviders()
      .then((next) => active && setView(next))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [view]);

  // Search turned out to be set up already (the first read hadn't answered): nothing to ask.
  const alreadyOn = state === "idle" && Boolean(view?.search.selected);
  useEffect(() => {
    if (alreadyOn) skipRef.current();
  }, [alreadyOn]);

  useEffect(() => {
    if (state !== "done" || !view) return;
    const timer = window.setTimeout(() => doneRef.current(view), 1_000);
    return () => window.clearTimeout(timer);
  }, [state, view]);

  const turnOn = async () => {
    const apiKey = key.trim();
    if (!apiKey || state !== "idle") return;
    setState("saving");
    setError(null);
    let saved = false;
    try {
      // The key is checked before the provider is chosen, so search never runs on a refused key.
      await api.updateWebProviders({ search: { providers: { [info.id]: { apiKey } } } });
      saved = true;
      const checked = await api.checkWebProvider({ tool: "search", provider: info.id });
      const check = checked.search.providers[info.id]?.check;
      if (check?.status !== "passed") {
        throw new Error(check?.message || `${info.name} didn't accept that key.`);
      }
      setView(await api.updateWebProviders({ search: { selected: info.id } }));
      setState("done");
    } catch (cause) {
      // A refused key is removed, like a refused model key; search stays off.
      if (saved) {
        await api
          .updateWebProviders({ search: { providers: { [info.id]: { apiKey: null } } } })
          .then(setView)
          .catch(() => {});
      }
      setError(requestErrorMessage(cause, "Couldn't turn on web search. Try again."));
      setState("idle");
    }
  };

  const icon = webProviderIcon(info.brand);
  return (
    <SetupLayout
      {...frame}
      body={
        state === "done"
          ? `Bots search the web with ${info.name}. You can change it in Settings → Providers.`
          : providerId === RECOMMENDED_SEARCH_PROVIDER
            ? `Bots look things up with a search service. ${info.name} gives the most accurate results; paste its API key to turn it on.`
            : `Bots look things up with a search service. Paste your ${info.name} API key to turn it on.`
      }
      footer={
        state === "done" ? null : (
          <>
            <SetupPrimary busy={state === "saving"} disabled={!key.trim()}>
              Turn on web search
            </SetupPrimary>
            {info.setupUrl ? (
              <SetupLink onClick={() => openExternal(info.setupUrl!)}>
                Get a key from {info.name}
              </SetupLink>
            ) : null}
          </>
        )
      }
      onSkip={state === "done" ? undefined : onSkip}
      onSubmit={() => void turnOn()}
      title={state === "done" ? "Web search is on" : "Let your bots search the web"}
      visual={
        <SearchVisual
          on={state === "done"}
          providerIcon={icon}
          providerName={state === "done" ? info.name : "Not set up yet"}
        />
      }
    >
      {state === "done" ? (
        <SetupSuccessMark />
      ) : (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={state === "saving"}>
              <button aria-label={`Search provider: ${info.name}`} className="setup-option" type="button">
                <span className="setup-option-icon">
                  {icon ? <img alt="" className="setup-search-tile" src={icon} /> : null}
                </span>
                <span className="setup-option-text">
                  <strong>
                    {info.name}
                    {info.id === RECOMMENDED_SEARCH_PROVIDER ? (
                      <span className="setup-tag">Recommended</span>
                    ) : null}
                  </strong>
                  <span>{info.description}</span>
                </span>
                <ChevronsUpDown aria-hidden="true" className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-[var(--radix-dropdown-menu-trigger-width)]"
            >
              {SEARCH_PROVIDER_LIST.map((provider) => (
                <DropdownMenuItem
                  key={provider.id}
                  onSelect={() => {
                    if (provider.id === providerId) return;
                    // A key belongs to one service.
                    setProviderId(provider.id);
                    setKey("");
                    setError(null);
                  }}
                >
                  {provider.name}
                  {provider.id === RECOMMENDED_SEARCH_PROVIDER ? " · Recommended" : ""}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            aria-invalid={Boolean(error)}
            aria-label={`${info.name} API key`}
            autoComplete="off"
            className="setup-input"
            onChange={(event) => {
              setKey(event.target.value);
              setError(null);
            }}
            placeholder={`${info.name} API key`}
            readOnly={state === "saving"}
            spellCheck={false}
            type="password"
            value={key}
          />
          {error ? (
            <p className="setup-note" data-tone="error" role="alert">
              {error}
            </p>
          ) : state === "saving" ? (
            <p className="setup-note">
              <span className="mr-1.5 inline-flex align-[-2px]">
                <LoadingOrb aria-hidden size={14} />
              </span>
              Running a test search with {info.name}…
            </p>
          ) : null}
        </>
      )}
    </SetupLayout>
  );
}

function VoiceScreen({
  frame,
  openAIKey,
  onDone,
  onSkip,
}: {
  frame: Frame;
  openAIKey: string | null;
  onDone: () => void;
  onSkip: () => void;
}) {
  const [useSameKey, setUseSameKey] = useState(Boolean(openAIKey));
  const [provider, setProvider] = useState<"openai" | "deepgram">("openai");
  const [key, setKey] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (state !== "done") return;
    const timer = window.setTimeout(() => doneRef.current(), 1_000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const turnOn = async () => {
    const chosen: TranscriptionSettings["provider"] = useSameKey ? "openai" : provider;
    const apiKey = useSameKey ? openAIKey : key.trim();
    if (!apiKey) return;
    setState("saving");
    setError(null);
    const settings = {
      provider: chosen,
      baseUrl: HOSTED_TRANSCRIPTION_ENDPOINTS[chosen] ?? "",
      model: HOSTED_TRANSCRIPTION_MODELS[chosen] ?? "",
      language: "",
    };
    let saved = false;
    try {
      await api.updateTranscriptionSettings({ ...settings, enabled: true, apiKey });
      saved = true;
      const check = await api.checkTranscription();
      if (check.level === "fail") {
        throw new Error(check.detail || "That key didn't work.");
      }
      requestRuntimeRefresh();
      setState("done");
    } catch (cause) {
      // A failed check, including a request error, must leave voice notes off.
      if (saved) {
        await api
          .updateTranscriptionSettings({ ...settings, enabled: false, apiKey: null })
          .catch(() => {});
        requestRuntimeRefresh();
      }
      setError(requestErrorMessage(cause, "Couldn't turn on voice notes. Try again."));
      setState("idle");
    }
  };

  return (
    <SetupLayout
      {...frame}
      body={
        state === "done"
          ? "Use the microphone in any chat."
          : "Record a message and your server turns it into text. Needs an OpenAI or Deepgram key."
      }
      footer={
        state === "done" ? null : (
          <SetupPrimary busy={state === "saving"} disabled={!useSameKey && !key.trim()}>
            Turn on voice notes
          </SetupPrimary>
        )
      }
      onSkip={state === "done" ? undefined : onSkip}
      onSubmit={() => void turnOn()}
      title={state === "done" ? "Voice notes are on" : "Talk instead of type?"}
      visual={<VoiceVisual />}
    >
      {state === "done" ? (
        <SetupSuccessMark />
      ) : (
        <>
          {openAIKey ? (
            <SetupOption
              detail={useSameKey ? "Selected" : "One tap, nothing to paste"}
              icon={<OpenAIMark size={20} />}
              onClick={() => setUseSameKey(!useSameKey)}
              selected={useSameKey}
              title="Use the same OpenAI key"
            />
          ) : null}
          {useSameKey ? null : (
            <>
              <div aria-label="Voice provider" className="setup-segmented" role="radiogroup">
                {(["openai", "deepgram"] as const).map((option) => (
                  <button
                    aria-checked={provider === option}
                    key={option}
                    onClick={() => {
                      if (option === provider) return;
                      // A key belongs to one service, as on iOS.
                      setProvider(option);
                      setKey("");
                      setError(null);
                    }}
                    role="radio"
                    type="button"
                  >
                    <ProviderMark id={option} />
                    {option === "openai" ? "OpenAI" : "Deepgram"}
                  </button>
                ))}
              </div>
              <input
                aria-invalid={Boolean(error)}
                aria-label="Voice API key"
                autoComplete="off"
                className="setup-input"
                onChange={(event) => setKey(event.target.value)}
                placeholder={provider === "openai" ? "OpenAI API key" : "Deepgram API key"}
                type="password"
                value={key}
              />
            </>
          )}
          {error ? (
            <p className="setup-note" data-tone="error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </SetupLayout>
  );
}

// A bot as the server stores it, to tell this screen's own bot from one made elsewhere.
const profileKey = (bot: Pick<Bot, "name" | "icon" | "color" | "description">) =>
  [bot.name.trim(), bot.icon, bot.color.toLowerCase(), bot.description.trim()].join("\u0000");

function BotScreen({
  frame,
  hasBots,
  arrivals,
  onCreateBot,
  onOpenBot,
  onFinish,
}: {
  frame: Frame;
  hasBots: boolean;
  /** Bots that appeared on the server after setup opened. */
  arrivals: readonly Bot[];
  onCreateBot: (profile: FirstBotProfile) => Promise<void>;
  onOpenBot: (bot: Bot) => Promise<void>;
  onFinish: () => void;
}) {
  const [avatar, setAvatar] = useState(randomAvatar);
  const [name, setName] = useState<string>(() => pick(BOT_NAMES));
  const [roleId, setRoleId] = useState<(typeof ROLES)[number]["id"]>("general");
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const role = useMemo(() => ROLES.find((option) => option.id === roleId) ?? ROLES[0], [roleId]);
  const displayName = name.trim() || "New Bot";
  const profile = {
    name: displayName,
    icon: avatar.shape,
    color: avatar.color,
    description: role.description,
  };
  // One request ID per profile: pressing Create again after an answer was lost repeats the
  // same request, so the server returns the bot it already made instead of making another.
  // A new name, look or job is a new request.
  const key = profileKey(profile);
  const request = useRef({ key: "", id: "" });
  if (request.current.key !== key) request.current = { key, id: crypto.randomUUID() };
  // What this screen sent, so its own bot (even one whose answer was lost) is never taken
  // for one made on another device, and the other devices' bots already answered for.
  const sent = useRef(new Set<string>());
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  // While a create is running nothing new is offered: it may be this screen's own bot.
  const elsewhere = creating
    ? undefined
    : arrivals.find((bot) => !answered.has(bot.id) && !sent.current.has(profileKey(bot)));

  // An arrival changes the offered action. A failed create (or opening a different
  // arrival) must not leave its error on the new bot's screen.
  useEffect(() => setError(null), [elsewhere?.id]);

  // Setup finishes only once the bot exists; a failure stays here so it can be retried.
  const create = async () => {
    if (creating || opening) return;
    setCreating(true);
    setError(null);
    setAnswered(new Set(arrivals.map((bot) => bot.id)));
    sent.current.add(key);
    try {
      await onCreateBot({ clientRequestId: request.current.id, ...profile });
    } catch (cause) {
      setError(requestErrorMessage(cause, "Couldn't create the bot. Try again."));
      setCreating(false);
    }
  };
  const open = async (bot: Bot) => {
    if (creating || opening) return;
    setOpening(true);
    setError(null);
    try {
      await onOpenBot(bot);
    } catch (cause) {
      setError(requestErrorMessage(cause, `Couldn't open ${bot.name}. Try again.`));
      setOpening(false);
    }
  };

  // Another device made a bot while this one was setting up: offer it, or make ours too.
  if (elsewhere && !hasBots) {
    const theirRole = ROLES.find((option) => option.description === elsewhere.description);
    const shape = (ROBOT_AVATAR_SHAPES as readonly string[]).includes(elsewhere.icon)
      ? (elsewhere.icon as RobotAvatarShape)
      : "chip";
    return (
      <SetupLayout
        {...frame}
        body={`${elsewhere.name} was just created on another device.`}
        footer={
          <>
            <SetupPrimary busy={opening}>Open it</SetupPrimary>
            <SetupLink onClick={() => void create()}>Create mine too</SetupLink>
          </>
        }
        onSubmit={() => void open(elsewhere)}
        title={`${elsewhere.name} is already here`}
        visual={
          <BotVisual
            color={elsewhere.color}
            greeting={`Hi, I'm ${elsewhere.name}. ${theirRole?.greeting ?? "What should we work on?"}`}
            name={elsewhere.name}
            role={theirRole?.label ?? "On your team"}
            shape={shape}
          />
        }
      >
        {error ? (
          <p className="setup-note" data-tone="error" role="alert">
            {error}
          </p>
        ) : null}
      </SetupLayout>
    );
  }

  if (hasBots) {
    return (
      <SetupLayout
        {...frame}
        body="Your server and AI are ready. Your bots are waiting."
        footer={<SetupPrimary>Open OpenTeam</SetupPrimary>}
        onSubmit={onFinish}
        title="You're all set"
        visual={
          <BotVisual
            color="#10b972"
            greeting="Welcome back. What should we work on?"
            name="Your team"
            role="Ready when you are"
            shape="chip"
          />
        }
      >
        <SetupSuccessMark />
      </SetupLayout>
    );
  }
  return (
    <SetupLayout
      {...frame}
      body="Give it a name and a job. You can change these anytime."
      footer={<SetupPrimary busy={creating}>Create {displayName}</SetupPrimary>}
      onSubmit={() => void create()}
      title="Create your first bot"
      visual={
        <BotVisual
          color={avatar.color}
          greeting={`Hi, I'm ${displayName}. ${role.greeting}`}
          name={displayName}
          role={role.label}
          shape={avatar.shape}
        />
      }
    >
      <span className="setup-label">Name</span>
      <div className="setup-row">
        {/* Below 860 px the preview is hidden, so the look shows here instead. */}
        <BotAvatarBadge color={avatar.color} shape={avatar.shape} />
        <input
          aria-label="Bot name"
          className="setup-input"
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          readOnly={creating}
          value={name}
        />
        <button
          aria-label="New look: shuffle the look"
          className="setup-secondary"
          onClick={() => setAvatar(randomAvatar())}
          style={{ flex: "0 0 auto", height: 46 }}
          type="button"
        >
          <Shuffle aria-hidden="true" className="size-4" /> New look
        </button>
      </div>
      <span className="setup-label">Job</span>
      <div aria-label="Job" className="setup-chips" role="radiogroup">
        {ROLES.map((option) => (
          <button
            aria-checked={roleId === option.id}
            key={option.id}
            onClick={() => setRoleId(option.id)}
            role="radio"
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
      {error ? (
        <p className="setup-note" data-tone="error" role="alert">
          {error}
        </p>
      ) : null}
    </SetupLayout>
  );
}
