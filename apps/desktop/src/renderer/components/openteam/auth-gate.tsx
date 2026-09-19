import { normalizeBaseUrl } from "@openteam/client-core/http";
import { ArrowLeft, ArrowRight, CircleAlert, LoaderCircle } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { authErrorMessage } from "../../lib/auth-error-message";
import { BotAvatarGlyph } from "./avatar-picker-icons";
import { VersionMismatchBanner } from "./version-mismatch-banner";

type LandingStage = "checking" | "welcome" | "endpoint" | "credentials";

function AuthBrand() {
  return (
    <header className="auth-brand">
      <div aria-hidden="true" className="auth-team-mark">
        <span>
          <BotAvatarGlyph color="#08c875" eyeColor="#111111" shape="chip" />
        </span>
        <span>
          <BotAvatarGlyph color="#1685ed" eyeColor="#111111" shape="tv-head" />
        </span>
        <span>
          <BotAvatarGlyph color="#ff9912" eyeColor="#111111" shape="helmet" />
        </span>
      </div>
      <h1 id="openteam-auth-heading">OpenTeam</h1>
      <p>Digital workers that run on your compute and work in your apps.</p>
    </header>
  );
}

function AuthFeedback({ message, id }: { message: string | null; id: string }) {
  const lastMessage = useRef(message);
  if (message) lastMessage.current = message;
  return (
    <div className="auth-feedback" data-visible={Boolean(message)}>
      <div className="auth-feedback-clip">
        <p aria-hidden="true" className="auth-error">
          <CircleAlert aria-hidden="true" size={15} />
          <span>{lastMessage.current}</span>
        </p>
      </div>
      <span aria-live="polite" aria-atomic="true" className="sr-only" id={id}>
        {message}
      </span>
    </div>
  );
}

function LandingShell({ children, stage }: { children: ReactNode; stage: LandingStage }) {
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = frame.current;
    const active = container?.querySelector<HTMLElement>("[data-active='true']");
    if (!container || !active) return;
    const measure = () => {
      container.style.height = `${active.getBoundingClientRect().height}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(active);
    return () => observer.disconnect();
  }, [stage]);
  return (
    <main className="auth-shell" data-stage={stage}>
      <VersionMismatchBanner showReview={false} />
      <div className="electron-window-drag-strip" />
      <section aria-labelledby="openteam-auth-heading" className="auth-onboarding-shell">
        <AuthBrand />
        <div className="auth-stage-frame" ref={frame}>
          {children}
        </div>
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
  const welcomeButton = useRef<HTMLButtonElement>(null);
  const serverInput = useRef<HTMLInputElement>(null);
  const usernameInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (auth.error) setError(auth.error);
  }, [auth.error]);

  useEffect(() => {
    if (error)
      (stage === "endpoint" ? serverInput : passwordInput).current?.focus({ preventScroll: true });
  }, [error, stage]);

  useEffect(() => {
    if (auth.status !== "signed-out") return;
    const target =
      stage === "endpoint" ? serverInput : stage === "credentials" ? usernameInput : welcomeButton;
    target.current?.focus({ preventScroll: true });
  }, [auth.status, stage]);

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
      setError(authErrorMessage(cause, "Could not sign in to OpenTeam"));
    } finally {
      setSubmitting(false);
    }
  };

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (!serverUrl.trim() || connecting) return;
    try {
      normalizeBaseUrl(serverUrl);
    } catch (cause) {
      setError(authErrorMessage(cause, "Enter your server address."));
      return;
    }
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
      setError(authErrorMessage(cause, "Could not connect to this OpenTeam server"));
    } finally {
      setConnecting(false);
    }
  };

  if (auth.status === "authenticated") return children;

  // Keep the active submit feedback mounted while sign-in verifies its new session.
  if (auth.status === "checking" && !submitting && !connecting) {
    return (
      <LandingShell stage="checking">
        <div aria-live="polite" className="auth-session-status" data-active="true" role="status">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
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
      <div
        aria-hidden={!welcomeVisible}
        inert={!welcomeVisible}
        data-active={welcomeVisible}
        className="auth-stage-layer auth-welcome-layer"
      >
        <button
          className="electron-no-drag auth-primary-button"
          disabled={!welcomeVisible}
          ref={welcomeButton}
          onClick={() => {
            setError(null);
            setStage("endpoint");
          }}
          type="button"
        >
          Log In
          <ArrowRight aria-hidden="true" className="size-[18px]" />
        </button>
        <AuthFeedback id="startup-error" message={welcomeVisible ? error : null} />
      </div>
      <form
        noValidate
        aria-hidden={!endpointVisible}
        aria-busy={connecting}
        inert={!endpointVisible}
        data-active={endpointVisible}
        className="electron-no-drag auth-stage-layer auth-endpoint-card"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !connecting) {
            event.preventDefault();
            setError(null);
            setStage("welcome");
          }
        }}
        onSubmit={(event) => void connect(event)}
      >
        <div className="auth-form-heading">
          <h2>Connect to your server</h2>
          <p>Use your existing OpenTeam server.</p>
        </div>
        <label className="auth-field-label" htmlFor="server-url">
          Server address
        </label>
        <input
          autoCapitalize="none"
          autoComplete="url"
          className="auth-credential-input"
          disabled={!endpointVisible || connecting}
          id="server-url"
          ref={serverInput}
          aria-describedby="server-hint server-error"
          aria-invalid={endpointVisible && Boolean(error)}
          inputMode="url"
          onChange={(event) => {
            setServerUrl(event.target.value);
            setUsername("");
            setPassword("");
            setError(null);
          }}
          placeholder="https://openteam.example.com"
          spellCheck={false}
          type="url"
          value={serverUrl}
        />
        <p className="auth-field-hint" id="server-hint">
          Use the server address from your OpenTeam setup.
        </p>
        <AuthFeedback id="server-error" message={endpointVisible ? error : null} />
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
            <span aria-live="polite">{connecting ? "Connecting…" : "Connect"}</span>
            {connecting ? (
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            ) : null}
          </button>
        </div>
      </form>
      <form
        noValidate
        aria-hidden={!credentialsVisible}
        aria-busy={submitting}
        inert={!credentialsVisible}
        data-active={credentialsVisible}
        className="electron-no-drag auth-stage-layer auth-credentials-card"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !submitting) {
            event.preventDefault();
            setError(null);
            setPassword("");
            setStage("endpoint");
          }
        }}
        onSubmit={(event) => void submit(event)}
      >
        <div className="auth-form-heading">
          <h2>Sign in to OpenTeam</h2>
          <p className="auth-connected-server" title={connectedApiBase}>
            {connectedApiBase}
          </p>
        </div>
        <label className="auth-field-label" htmlFor="username">
          Username
        </label>
        <input
          autoCapitalize="none"
          autoComplete="username"
          className="auth-credential-input"
          disabled={!credentialsVisible || submitting}
          id="username"
          ref={usernameInput}
          aria-describedby="credentials-error"
          onChange={(event) => {
            setUsername(event.target.value);
            setError(null);
          }}
          placeholder="Username"
          spellCheck={false}
          value={username}
        />
        <label className="auth-field-label" htmlFor="password">
          Password
        </label>
        <input
          autoComplete="current-password"
          className="auth-credential-input"
          disabled={!credentialsVisible || submitting}
          id="password"
          ref={passwordInput}
          aria-describedby="credentials-error"
          aria-invalid={credentialsVisible && Boolean(error)}
          onChange={(event) => {
            setPassword(event.target.value);
            setError(null);
          }}
          placeholder="Password"
          type="password"
          value={password}
        />
        <AuthFeedback id="credentials-error" message={credentialsVisible ? error : null} />
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
            <span aria-live="polite">{submitting ? "Signing in…" : "Sign In"}</span>
            {submitting ? (
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            ) : null}
          </button>
        </div>
      </form>
    </LandingShell>
  );
}
