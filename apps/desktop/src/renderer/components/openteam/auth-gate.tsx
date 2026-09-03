import { clientErrorMessage } from "@openteam/product-core/redaction";
import { ArrowLeft, ArrowRight, LoaderCircle } from "lucide-react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  clearAuthCredentialsForServerChange,
  refreshAuthSession,
  signIn,
  signInToServer,
  testServerConnection,
} from "../../client/auth";
import { API_BASE } from "../../client/http";
import { saveConfiguredApiBase } from "../../client/runtime-url";
import { useAuthSession } from "../../hooks/use-auth-session";
import { BotAvatarGlyph, type BotAvatarShape } from "./avatar-picker-icons";
import { VersionMismatchBanner } from "./version-mismatch-banner";

type LandingStage = "checking" | "welcome" | "endpoint" | "credentials";

const decorations = [
  {
    color: "#08c875",
    shape: "cloud",
    left: "16%",
    top: "12%",
    size: "clamp(72px, 8vw, 112px)",
    rotate: "-8deg",
  },
  {
    color: "#f72591",
    shape: "drop",
    left: "64%",
    top: "17%",
    size: "clamp(58px, 6vw, 84px)",
    rotate: "18deg",
  },
  {
    color: "#8850f5",
    shape: "pill",
    left: "-2%",
    top: "35%",
    size: "clamp(62px, 7vw, 94px)",
    rotate: "80deg",
  },
  {
    color: "#9d683e",
    shape: "circle",
    left: "91%",
    top: "34%",
    size: "clamp(64px, 7vw, 98px)",
    rotate: "-22deg",
  },
  {
    color: "#ff9912",
    shape: "circle",
    left: "-3%",
    top: "61%",
    size: "clamp(76px, 9vw, 122px)",
    rotate: "15deg",
  },
  {
    color: "#ff2445",
    shape: "circle",
    left: "94%",
    top: "61%",
    size: "clamp(76px, 9vw, 122px)",
    rotate: "-22deg",
  },
  {
    color: "#1685ed",
    shape: "square",
    left: "8%",
    top: "80%",
    size: "clamp(68px, 8vw, 108px)",
    rotate: "4deg",
  },
  {
    color: "#08bca9",
    shape: "circle",
    left: "82%",
    top: "80%",
    size: "clamp(64px, 7vw, 98px)",
    rotate: "-18deg",
  },
  {
    color: "#ff6811",
    shape: "hexagon",
    left: "46%",
    top: "84%",
    size: "clamp(74px, 9vw, 118px)",
    rotate: "4deg",
  },
] as const satisfies readonly {
  color: string;
  left: string;
  rotate: string;
  shape: BotAvatarShape;
  size: string;
  top: string;
}[];

function AuthBotField() {
  return (
    <div aria-hidden="true" className="auth-bot-field">
      {decorations.map((decoration, index) => {
        const direction = index % 2 === 0 ? 1 : -1;
        return (
          <span
            className="auth-bot-position"
            data-exits={index >= 6 ? "true" : undefined}
            key={`${decoration.shape}-${decoration.color}`}
            style={
              {
                "--auth-bot-delay": `${index * -310}ms`,
                "--auth-bot-duration": `${3500 + (index % 4) * 360}ms`,
                "--auth-bot-left": decoration.left,
                "--auth-bot-rotation": decoration.rotate,
                "--auth-bot-size": decoration.size,
                "--auth-bot-top": decoration.top,
                "--auth-bot-travel-x": `${direction * 3}px`,
                "--auth-bot-travel-y": `${-5 - (index % 3) * 1.5}px`,
                "--auth-bot-tilt": `${direction * 2.2}deg`,
              } as CSSProperties
            }
          >
            <span className="auth-idle-bot">
              <BotAvatarGlyph
                className="size-full"
                color={decoration.color}
                eyeColor="#111111"
                shape={decoration.shape}
              />
            </span>
          </span>
        );
      })}
    </div>
  );
}

function LandingShell({ children, stage }: { children: ReactNode; stage: LandingStage }) {
  return (
    <main className="auth-shell" data-stage={stage}>
      <VersionMismatchBanner showReview={false} />
      <div className="electron-window-drag-strip" />
      <AuthBotField />
      <section aria-labelledby="openteam-auth-heading" className="auth-onboarding-shell">
        <div className="auth-glass auth-brand-card">
          <h1 id="openteam-auth-heading">OpenTeam</h1>
          <p>Your team of always-on Bots that finish the work</p>
        </div>
        <div className="auth-stage-frame">{children}</div>
      </section>
    </main>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuthSession();
  const [stage, setStage] = useState<Exclude<LandingStage, "checking">>("welcome");
  const [serverUrl, setServerUrl] = useState(API_BASE);
  const [connectedApiBase, setConnectedApiBase] = useState(API_BASE);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void refreshAuthSession();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (connectedApiBase === API_BASE) {
        await signIn(username, password);
      } else {
        await signInToServer(connectedApiBase, username, password);
        window.location.reload();
      }
      setPassword("");
    } catch (cause) {
      setError(clientErrorMessage(cause, "Could not sign in to OpenTeam"));
    } finally {
      setSubmitting(false);
    }
  };

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (!serverUrl.trim() || connecting) return;
    setConnecting(true);
    setError(null);
    try {
      const connection = await testServerConnection(serverUrl);
      const serverChanged = connection.baseUrl !== API_BASE;
      if (serverChanged) await clearAuthCredentialsForServerChange();
      saveConfiguredApiBase(localStorage, connection.baseUrl);
      setServerUrl(connection.baseUrl);
      setConnectedApiBase(connection.baseUrl);

      if (connection.mode === "disabled") {
        if (serverChanged) window.location.reload();
        else await refreshAuthSession();
        return;
      }
      setStage("credentials");
    } catch (cause) {
      setError(clientErrorMessage(cause, "Could not connect to this OpenTeam server"));
    } finally {
      setConnecting(false);
    }
  };

  if (auth.status === "authenticated") return children;

  if (auth.status === "checking") {
    return (
      <LandingShell stage="checking">
        <div aria-live="polite" className="auth-glass auth-session-status">
          <LoaderCircle className="size-4 animate-spin" />
          Checking session…
        </div>
      </LandingShell>
    );
  }

  const welcomeVisible = stage === "welcome";
  const endpointVisible = stage === "endpoint";
  const credentialsVisible = stage === "credentials";

  return (
    <LandingShell stage={stage}>
      <div aria-hidden={!welcomeVisible} className="auth-stage-layer auth-welcome-layer">
        <button
          className="electron-no-drag auth-primary-button"
          disabled={!welcomeVisible}
          onClick={() => {
            setError(null);
            setStage("endpoint");
          }}
          type="button"
        >
          Log In
          <ArrowRight aria-hidden="true" className="size-[18px]" />
        </button>
      </div>
      <form
        aria-hidden={!endpointVisible}
        className="electron-no-drag auth-glass auth-stage-layer auth-endpoint-card"
        onSubmit={(event) => void connect(event)}
      >
        <label className="auth-field-label" htmlFor="server-url">
          Server endpoint
        </label>
        <input
          autoCapitalize="none"
          autoComplete="url"
          className="auth-credential-input"
          disabled={!endpointVisible || connecting}
          id="server-url"
          inputMode="url"
          onChange={(event) => {
            setServerUrl(event.target.value);
            setError(null);
          }}
          placeholder="https://openteam.example.com"
          spellCheck={false}
          type="url"
          value={serverUrl}
        />
        <p className="auth-field-hint">The Connect button verifies this server before saving it.</p>
        <div className="auth-error-slot">
          {error ? (
            <p aria-live="polite" className="auth-error">
              {error}
            </p>
          ) : null}
        </div>
        <div className="auth-actions">
          <button
            className="auth-secondary-button"
            disabled={!endpointVisible || connecting}
            onClick={() => {
              setError(null);
              setStage("welcome");
            }}
            type="button"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back
          </button>
          <button
            className="auth-primary-button auth-connect-button"
            disabled={!endpointVisible || connecting || !serverUrl.trim()}
            type="submit"
          >
            {connecting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {connecting ? "Connecting…" : "Connect"}
            {connecting ? null : <ArrowRight aria-hidden="true" className="size-4" />}
          </button>
        </div>
      </form>
      <form
        aria-hidden={!credentialsVisible}
        className="electron-no-drag auth-glass auth-stage-layer auth-credentials-card"
        onSubmit={(event) => void submit(event)}
      >
        <label className="sr-only" htmlFor="username">
          Username
        </label>
        <input
          autoCapitalize="none"
          autoComplete="username"
          className="auth-credential-input"
          disabled={!credentialsVisible || submitting}
          id="username"
          onChange={(event) => {
            setUsername(event.target.value);
            setError(null);
          }}
          placeholder="Username"
          spellCheck={false}
          value={username}
        />
        <label className="sr-only" htmlFor="password">
          Password
        </label>
        <input
          autoComplete="current-password"
          className="auth-credential-input"
          disabled={!credentialsVisible || submitting}
          id="password"
          onChange={(event) => {
            setPassword(event.target.value);
            setError(null);
          }}
          placeholder="Password"
          type="password"
          value={password}
        />
        <div className="auth-error-slot">
          {error ? (
            <p aria-live="polite" className="auth-error">
              {error}
            </p>
          ) : null}
        </div>
        <div className="auth-actions">
          <button
            className="auth-secondary-button"
            disabled={!credentialsVisible || submitting}
            onClick={() => {
              setError(null);
              setPassword("");
              setStage("endpoint");
            }}
            type="button"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back
          </button>
          <button
            className="auth-primary-button auth-sign-in-button"
            disabled={!credentialsVisible || submitting || !username.trim() || !password}
            type="submit"
          >
            {submitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {submitting ? "Signing In…" : "Sign In"}
            {submitting ? null : <ArrowRight aria-hidden="true" className="size-4" />}
          </button>
        </div>
      </form>
    </LandingShell>
  );
}
