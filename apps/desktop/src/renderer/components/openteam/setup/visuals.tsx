import type { RobotAvatarShape } from "@openteam/contracts/robot-avatar";
import { CircleAlert, ExternalLink, Globe, KeyRound, Lock, Mic, Search } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { BotAvatarGlyph } from "../avatar-picker-icons";
import { CrossFade } from "./cross-fade";
import { AppIcon, hasProviderIcon, ProviderIcon } from "./app-icons";
import { ProviderTile } from "./provider-marks";
import { SetupSuccessMark } from "./setup-layout";

// Per-item index for staggered CSS entrances (see --i in setup.css).
const nth = (index: number) => ({ "--i": index }) as CSSProperties;

const FOCUSED = {
  chatgpt: { providerId: "openai-codex", name: "ChatGPT" },
  claude: { providerId: "claude-code", name: "Claude" },
} as const;

// The logos' last look. Each screen mounts its own picture, so a new one starts from here
// and eases to its own focus instead of jumping.
let shownFocus: keyof typeof FOCUSED | undefined;

/**
 * Provider choices, shown as the apps people already use. With `focus` (connecting ChatGPT
 * or Claude) the others step back and the card names it.
 */
export function ProvidersVisual({ focus }: { focus?: keyof typeof FOCUSED }) {
  const focused = focus ? FOCUSED[focus] : undefined;
  const [shown, setShown] = useState(shownFocus);
  useEffect(() => {
    shownFocus = focus;
    const frame = requestAnimationFrame(() => setShown(focus));
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  return (
    <div>
      <div className="setup-logos">
        <span data-dim={(shown && shown !== "chatgpt") || undefined}>
          <AppIcon app="chatgpt" size={58} />
        </span>
        <span data-dim={(shown && shown !== "claude") || undefined}>
          <AppIcon app="claude" size={58} />
        </span>
        <span data-dim={shown ? true : undefined}>
          <ProviderTile provider="openrouter" size={58} />
        </span>
      </div>
      <ChatVisual phase="idle" providerId={focused?.providerId} providerName={focused?.name} />
    </div>
  );
}

/** Counts up to a number once, easing out; reduced motion shows the number at once. */
function useCountUp(target: number, duration = 700) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      setValue(target * (1 - (1 - progress) ** 3));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);
  return value;
}

function LatencyBadge({ latencyMs }: { latencyMs: number }) {
  const shown = useCountUp(latencyMs);
  return <span className="setup-badge">Replied in {(shown / 1000).toFixed(1)} s</span>;
}

const BURST_COLORS = ["#08c875", "#1685ed", "#ff9912", "#925df2", "#ffd60a"];

/**
 * The "It works!" mark: a check that pops and draws on, a ring that rolls out from it, and
 * a burst of particles of a few sizes thrown at slightly different angles and distances.
 */
function CelebrationMark() {
  return (
    <span aria-hidden="true" className="setup-chat-check">
      <span className="setup-burst">
        {Array.from({ length: 18 }, (_, index) => (
          <i
            // biome-ignore lint/suspicious/noArrayIndexKey: Decorative particles never reorder.
            key={index}
            style={
              {
                "--a": `${index * 20 + ((index * 7) % 11)}deg`,
                "--d": `${54 + ((index * 13) % 5) * 12}px`,
                "--s": `${0.7 + ((index * 5) % 4) * 0.22}`,
                "--t": `${(index % 3) * 40}ms`,
                background: BURST_COLORS[index % BURST_COLORS.length],
              } as CSSProperties
            }
          />
        ))}
      </span>
      <SetupSuccessMark />
    </span>
  );
}

/** A real test message to the model, as a tiny chat. */
export function ChatVisual({
  phase,
  providerId,
  providerName,
  modelName,
  latencyMs,
  error,
  celebrate = false,
}: {
  phase: "idle" | "testing" | "passed" | "failed";
  /** The model's provider: its icon heads the card (the app icon for a plan). */
  providerId?: string;
  providerName?: string;
  modelName?: string;
  latencyMs?: number;
  error?: string;
  celebrate?: boolean;
}) {
  return (
    <div className="setup-card setup-chat">
      {/* "It works!": a light sweeps across the card once. */}
      {celebrate ? <span aria-hidden="true" className="setup-sweep" /> : null}
      {celebrate ? <CelebrationMark /> : null}
      <div className="setup-chat-head">
        {providerId && hasProviderIcon(providerId) ? (
          <ProviderIcon id={providerId} size={22} />
        ) : (
          <BotAvatarGlyph
            color="#925df2"
            eyeColor="#111111"
            height={22}
            shape="classic"
            width={22}
          />
        )}
        {providerName ?? "Your bots' AI"}
        <span>{modelName ?? "Not connected yet"}</span>
      </div>
      <div className="setup-bubble" data-from="you">
        Reply with the single word OK.
      </div>
      {phase === "testing" ? (
        <div className="setup-bubble" data-from="bot" key="typing">
          <div className="setup-typing">
            <i />
            <i />
            <i />
          </div>
        </div>
      ) : phase === "passed" ? (
        <>
          <div className="setup-bubble" data-from="bot" key="reply">
            OK
          </div>
          <LatencyBadge latencyMs={latencyMs ?? 0} />
        </>
      ) : phase === "failed" ? (
        <div className="setup-bubble" data-from="bot" data-tone="error" key="failed">
          <CircleAlert aria-hidden="true" className="inline size-3.5" /> {error ?? "No reply"}
        </div>
      ) : (
        <div className="setup-bubble" data-from="bot" style={{ opacity: 0.45 }}>
          …
        </div>
      )}
    </div>
  );
}

const SIGN_IN_HOSTS: Record<string, string> = {
  "claude-code": "claude.ai",
  "openai-codex": "auth.openai.com",
};

/** Sign-in happens in the browser; the app picks it up from there, or the address is pasted. */
export function BrowserVisual({
  providerId,
  provider,
  code,
  paste = false,
  signedIn = false,
}: {
  providerId: string;
  /** The provider's name, as the sign-in page shows it. */
  provider: string;
  code?: string;
  paste?: boolean;
  signedIn?: boolean;
}) {
  const host = SIGN_IN_HOSTS[providerId] ?? provider;
  return (
    <div>
      <div className="setup-card setup-browser">
        <div className="setup-browser-bar">
          <Lock aria-hidden="true" className="size-3.5" />
          <span>{host}</span>
        </div>
        <div className="setup-browser-body">
          {signedIn ? (
            <SetupSuccessMark className="setup-browser-done" />
          ) : hasProviderIcon(providerId) ? (
            <ProviderIcon id={providerId} size={48} />
          ) : (
            <KeyRound aria-hidden="true" className="size-8" />
          )}
          <strong>
            <CrossFade
              value={
                signedIn ? "You're signed in" : code ? "Enter your code" : `Sign in to ${provider}`
              }
            />
          </strong>
          {signedIn ? (
            <span className="setup-browser-note">
              You can close this tab and return to OpenTeam
            </span>
          ) : code ? (
            <span className="setup-browser-code">
              {[...code].map((character, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Code characters repeat and never reorder.
                <span key={index} style={nth(index)}>
                  {character}
                </span>
              ))}
            </span>
          ) : (
            <span>Allow OpenTeam to use your plan</span>
          )}
          {signedIn ? null : <span className="setup-browser-button">Continue</span>}
        </div>
      </div>
      <div className="setup-return">
        <ExternalLink aria-hidden="true" className="size-3.5" />
        {signedIn
          ? "Back in OpenTeam"
          : paste
            ? "Then paste the address your browser lands on"
            : "OpenTeam continues as soon as you're done"}
      </div>
    </div>
  );
}

/** An API key, kept on the server. */
export function KeyVisual({
  providerId,
  provider,
  prefix,
}: {
  providerId: string;
  provider: string;
  prefix: string;
}) {
  return (
    <div className="setup-card setup-chat">
      <div className="setup-chat-head">
        {hasProviderIcon(providerId) ? (
          <ProviderIcon id={providerId} size={22} />
        ) : (
          <KeyRound aria-hidden="true" className="size-4" />
        )}
        {provider} API key
        <span>Stored on your server</span>
      </div>
      <div className="setup-bubble" data-from="bot">
        {prefix}••••••••••••••••••••
      </div>
      <span className="setup-badge">
        <Lock aria-hidden="true" className="size-3" /> Only your server sees it
      </span>
    </div>
  );
}

const SEARCH_RESULTS = [
  { site: "timeout.com", title: "The best meeting venues in Lisbon" },
  { site: "visitlisboa.com", title: "Event spaces for groups of 20–40" },
  { site: "tripadvisor.com", title: "Top-rated offsite venues, 2026 reviews" },
] as const;

/** A bot looking something up: the question, then fresh results with their sources. */
export function SearchVisual({
  providerName,
  providerIcon,
  on = false,
}: {
  providerName: string;
  providerIcon?: string;
  /** Search was just turned on: the card says so. */
  on?: boolean;
}) {
  return (
    <div className="setup-card setup-chat">
      {on ? (
        <span aria-hidden="true" className="setup-chat-check">
          <SetupSuccessMark />
        </span>
      ) : null}
      <div className="setup-chat-head">
        {providerIcon ? (
          <img alt="" className="setup-search-logo" src={providerIcon} />
        ) : (
          <Search aria-hidden="true" className="size-4" />
        )}
        Web search
        <span>{providerName}</span>
      </div>
      <div className="setup-bubble" data-from="you">
        Find a venue in Lisbon for our team offsite.
      </div>
      <ul className="setup-search-results">
        {SEARCH_RESULTS.map((result, index) => (
          <li key={result.site} style={nth(index)}>
            <Globe aria-hidden="true" className="size-3.5" />
            <span>
              <strong>{result.title}</strong>
              <small>{result.site}</small>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A voice note becoming text. */
export function VoiceVisual() {
  return (
    <div className="setup-mic">
      <span className="setup-mic-button">
        <Mic aria-hidden="true" className="size-9" />
      </span>
      <div className="setup-wave">
        {Array.from({ length: 18 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Decorative bars never reorder.
          <i key={index} style={{ animationDelay: `${(index % 6) * -0.18}s` }} />
        ))}
      </div>
      <div className="setup-card setup-chat" style={{ width: "100%" }}>
        <div className="setup-bubble" data-from="you">
          Find three venues for the team offsite under $5,000.
        </div>
      </div>
    </div>
  );
}

/** The bot's look beside its name, for windows too narrow for the preview (see setup.css). */
export function BotAvatarBadge({ shape, color }: { shape: RobotAvatarShape; color: string }) {
  return (
    <span aria-hidden="true" className="setup-name-avatar" key={`${shape}-${color}`}>
      <BotAvatarGlyph color={color} eyeColor="#111111" shape={shape} />
    </span>
  );
}

/** A live preview of the bot being created. */
export function BotVisual({
  name,
  shape,
  color,
  greeting,
  role,
}: {
  name: string;
  shape: RobotAvatarShape;
  color: string;
  greeting: string;
  role: string;
}) {
  return (
    <div className="setup-card setup-profile">
      {/* A new look springs in with a small wiggle; the words cross-fade as they change. */}
      <span className="setup-profile-avatar" key={`${shape}-${color}`}>
        <BotAvatarGlyph color={color} eyeColor="#111111" mode="idle" shape={shape} />
      </span>
      <strong>
        <CrossFade value={name} />
      </strong>
      <span>
        <CrossFade value={role} />
      </span>
      <div className="setup-bubble" data-from="bot">
        <CrossFade value={greeting} />
      </div>
    </div>
  );
}
