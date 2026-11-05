import { withDefaultScheme } from "@openteam/client-core/http";
import type { SystemVersionView } from "@openteam/contracts";
import { Bot, Check, Copy, Server, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  clearAuthCredentialsForServerChange,
  getServerSignOut,
  refreshAuthSession,
  SERVER_SIGN_OUT_NOTE,
  signIn,
  signInToServer,
  testServerConnection,
} from "../../client/auth";
import { API_BASE } from "../../client/http";
import { CONFIGURED_API_BASE_KEY, saveConfiguredApiBase } from "../../client/runtime-url";
import type { useAuthSession } from "../../hooks/use-auth-session";
import { authErrorMessage } from "../../lib/auth-error-message";
import { serverAddressProblem } from "../../lib/server-address";
import { reloadInto } from "./first-run-shell";
import { changeScreen } from "./setup/screen-transition";
import {
  SetupDrawnCheck,
  SetupLayout,
  SetupLink,
  SetupPrimary,
  SetupSwap,
  useCopied,
  useSetupKeyboard,
} from "./setup/setup-layout";
import { RobotsVisual, TerminalVisual } from "./setup/sign-in-visuals";

type Stage = "welcome" | "endpoint" | "credentials";
type LocalServer = { url: string; username?: string };

const INSTALL_COMMAND = "curl -fsSL https://openteam.so/install | sh";

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Reads the release a server reports; the address already answered, so this is best effort. */
const serverVersion = async (baseUrl: string): Promise<string | null> => {
  try {
    const response = await fetch(`${baseUrl}/api/system/version`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    return ((await response.json()) as SystemVersionView).releaseVersion;
  } catch {
    return null;
  }
};

/** Welcome, server address, and sign-in: the first stage of setup, before an account exists here. */
export default function SignInFlow({ auth }: { auth: ReturnType<typeof useAuthSession> }) {
  // When the server signed this device out (for example, the sign-in expired partway through
  // setup), the account step opens for the same server and account and says why.
  const [signedOut] = useState(getServerSignOut);
  const [stage, setStage] = useState<Stage>(signedOut ? "credentials" : "welcome");
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  // A server chosen before is offered again; otherwise the field starts empty with its example.
  const [serverUrl, setServerUrl] = useState(() =>
    localStorage.getItem(CONFIGURED_API_BASE_KEY) ? API_BASE : ""
  );
  const [connectedApiBase, setConnectedApiBase] = useState(API_BASE);
  const [username, setUsername] = useState(signedOut?.username ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localServer, setLocalServer] = useState<LocalServer | null>(null);
  const [showInstall, setShowInstall] = useState(false);
  const [stillTrying, setStillTrying] = useState(false);
  const [found, setFound] = useState<string | null>(null);
  const [installCopied, copyInstall] = useCopied();
  // Each connection attempt has a number; leaving the screen makes a late answer stale.
  const attempt = useRef(0);

  // Each step changes as a view transition, like the setup screens after sign-in.
  const goTo = (next: Stage, back = false) =>
    changeScreen(
      () => {
        setDirection(back ? "back" : "forward");
        setError(null);
        setStage(next);
      },
      back ? "back" : "forward"
    );
  // Signing in to another server reloads the app; the panel's content eases out first so
  // the setup screens that follow feel like the next step rather than a restart.
  const [leaving, setLeaving] = useState(false);
  const leaveEndpoint = () => {
    attempt.current += 1;
    setConnecting(false);
    setStillTrying(false);
    setFound(null);
    goTo("welcome", true);
  };
  const leaveCredentials = () => {
    setPassword("");
    goTo("endpoint", true);
  };
  useSetupKeyboard(
    stage === "credentials" ? leaveCredentials : stage === "endpoint" ? leaveEndpoint : undefined
  );

  useEffect(() => {
    if (auth.error) setError(auth.error);
  }, [auth.error]);

  useEffect(() => {
    // A saved server choice wins; otherwise offer the server installed on this computer.
    if (localStorage.getItem(CONFIGURED_API_BASE_KEY)) return;
    void window.openteam?.localServer
      ?.detect()
      .then((server) => {
        if (!server) return;
        setLocalServer(server);
        setServerUrl(server.url);
      })
      .catch(() => {});
  }, []);

  const submit = async () => {
    if (!username.trim() || !password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (connectedApiBase === API_BASE) {
        await signIn(username, password);
      } else {
        await signInToServer(connectedApiBase, username, password);
        setLeaving(true);
        await new Promise((resolve) => window.setTimeout(resolve, 260));
        reloadInto(connectedApiBase);
      }
      setPassword("");
    } catch (cause) {
      setError(authErrorMessage(cause, "Could not sign in to OpenTeam"));
    } finally {
      setSubmitting(false);
    }
  };

  const connectTo = async (address: string, knownUsername?: string) => {
    if (!address.trim() || connecting) return;
    const problem = serverAddressProblem(address);
    if (problem) {
      setError(problem);
      return;
    }
    const candidate = withDefaultScheme(address);
    const id = ++attempt.current;
    const current = () => attempt.current === id;
    setConnecting(true);
    setError(null);
    setFound(null);
    setStillTrying(false);
    // A slow answer usually means the wrong network; say so instead of a silent spinner.
    const slow = window.setTimeout(() => current() && setStillTrying(true), 4_000);
    try {
      const connection = await testServerConnection(candidate);
      // Back or Esc during the attempt cancelled it.
      if (!current()) return;
      const serverChanged = connection.baseUrl !== API_BASE;
      if (serverChanged) await clearAuthCredentialsForServerChange();
      saveConfiguredApiBase(localStorage, connection.baseUrl);
      setServerUrl(connection.baseUrl);
      setConnectedApiBase(connection.baseUrl);
      if (connection.mode === "disabled") {
        if (serverChanged) reloadInto(connection.baseUrl);
        else await refreshAuthSession();
        return;
      }
      if (knownUsername) setUsername(knownUsername);
      if (stage === "endpoint") {
        const version = await serverVersion(connection.baseUrl);
        if (!current()) return;
        setFound(version ? `Found OpenTeam ${version}` : "Found OpenTeam");
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        if (!current()) return;
      }
      goTo("credentials");
    } catch (cause) {
      if (!current()) return;
      if (stage !== "endpoint") goTo("endpoint");
      setError(authErrorMessage(cause, "Could not connect to this OpenTeam server"));
    } finally {
      window.clearTimeout(slow);
      if (current()) {
        setStillTrying(false);
        setConnecting(false);
      }
    }
  };

  if (stage === "welcome") {
    return (
      <SetupLayout
        body="Let's connect to your server and set up your first bot. It takes about two minutes."
        direction={direction}
        footer={
          <>
            <SetupPrimary busy={connecting}>Get started</SetupPrimary>
            {localServer || showInstall ? null : (
              <SetupLink onClick={() => setShowInstall(true)}>
                I still need to install the server
              </SetupLink>
            )}
          </>
        }
        onSubmit={() => {
          if (localServer) void connectTo(localServer.url, localServer.username);
          else goTo("endpoint");
        }}
        screenKey="welcome"
        stage={0}
        title="Welcome to OpenTeam"
        visual={<RobotsVisual />}
      >
        <ol className="setup-steps">
          <li>
            <Server aria-hidden="true" className="size-4" />
            <span>
              <strong>Connect your server</strong>
              <small>The one you installed with the terminal</small>
            </span>
          </li>
          <li>
            <Sparkles aria-hidden="true" className="size-4" />
            <span>
              <strong>Choose your bots' AI</strong>
              <small>ChatGPT, Claude, or an API key</small>
            </span>
          </li>
          <li>
            <Bot aria-hidden="true" className="size-4" />
            <span>
              <strong>Meet your first bot</strong>
              <small>Give it a name and a job</small>
            </span>
          </li>
        </ol>
        {localServer ? (
          <p className="setup-note" data-tone="success">
            <SetupDrawnCheck />
            OpenTeam is running on this computer.
          </p>
        ) : null}
        {showInstall ? (
          <div className="setup-install">
            <div>
              <code>{INSTALL_COMMAND}</code>
              <button
                aria-label={installCopied ? "Copied" : "Copy the install command"}
                onClick={() => copyInstall(INSTALL_COMMAND)}
                type="button"
              >
                <SetupSwap
                  active={installCopied}
                  off={<Copy aria-hidden="true" className="size-3.5" />}
                  on={
                    <>
                      <Check aria-hidden="true" className="size-3.5" /> Copied
                    </>
                  }
                />
              </button>
            </div>
            Run this on the computer that will host your bots, then come back here.
          </div>
        ) : null}
        {error ? (
          <p className="setup-note" data-tone="error" role="alert">
            {error}
          </p>
        ) : null}
      </SetupLayout>
    );
  }

  if (stage === "endpoint") {
    return (
      <SetupLayout
        body="Paste the address your terminal printed at the end of setup."
        direction={direction}
        footer={
          <SetupPrimary busy={connecting} disabled={!serverUrl.trim()}>
            Connect
          </SetupPrimary>
        }
        onBack={leaveEndpoint}
        onSubmit={() => void connectTo(serverUrl)}
        screenKey="endpoint"
        stage={0}
        title="Where's your server?"
        visual={<TerminalVisual highlight="server" />}
      >
        <label className="setup-label" htmlFor="server-url">
          Server address
        </label>
        <input
          aria-describedby="server-hint"
          aria-invalid={Boolean(error)}
          autoCapitalize="none"
          autoComplete="url"
          // biome-ignore lint/a11y/noAutofocus: The address is the only thing this screen asks for.
          autoFocus
          aria-busy={connecting}
          className="setup-input"
          id="server-url"
          inputMode="url"
          onChange={(event) => {
            setServerUrl(event.target.value);
            setUsername("");
            setPassword("");
            setError(null);
          }}
          placeholder="192.168.1.20:8787"
          // Read-only, not disabled, while connecting, so focus stays put for keyboard users.
          readOnly={connecting}
          spellCheck={false}
          type="text"
          value={serverUrl}
        />
        <p
          aria-live={error ? undefined : "polite"}
          className="setup-note"
          data-tone={error ? "error" : found ? "success" : undefined}
          id="server-hint"
          role={error ? "alert" : undefined}
        >
          {error ? (
            error
          ) : found ? (
            <>
              <SetupDrawnCheck />
              {found}
            </>
          ) : stillTrying ? (
            `Still trying ${hostOf(withDefaultScheme(serverUrl))}… Make sure the server is on and you're on the same network or VPN.`
          ) : localServer ? (
            <>
              Lost it? Run <code>openteam status</code> on your server, or{" "}
              <button
                className="setup-link-inline"
                onClick={() => void connectTo(localServer.url, localServer.username)}
                type="button"
              >
                use this computer
              </button>
              .
            </>
          ) : (
            <>
              Lost it? Run <code>openteam status</code> on your server.
            </>
          )}
        </p>
      </SetupLayout>
    );
  }

  return (
    <SetupLayout
      body="Use the account you created in the terminal."
      direction={direction}
      leaving={leaving}
      footer={
        <SetupPrimary busy={submitting} disabled={!username.trim() || !password}>
          Sign in
        </SetupPrimary>
      }
      onBack={leaveCredentials}
      onSubmit={() => void submit()}
      screenKey="credentials"
      stage={0}
      title="Sign in to your server"
      visual={<TerminalVisual highlight="username" />}
    >
      <p className="setup-host" title={connectedApiBase}>
        <Server aria-hidden="true" className="size-3.5" />
        <span>{hostOf(connectedApiBase)}</span>
      </p>
      <label className="setup-label" htmlFor="username">
        Username
      </label>
      <input
        autoCapitalize="none"
        autoComplete="username"
        // biome-ignore lint/a11y/noAutofocus: Focus lands on the first empty field.
        autoFocus={!username}
        className="setup-input"
        id="username"
        onChange={(event) => {
          setUsername(event.target.value);
          setError(null);
        }}
        placeholder="Username"
        readOnly={submitting}
        spellCheck={false}
        value={username}
      />
      <label className="setup-label" htmlFor="password">
        Password
      </label>
      <input
        aria-describedby="credentials-hint"
        aria-invalid={Boolean(error)}
        autoComplete="current-password"
        // biome-ignore lint/a11y/noAutofocus: Focus lands on the first empty field.
        autoFocus={Boolean(username)}
        className="setup-input"
        id="password"
        onChange={(event) => {
          setPassword(event.target.value);
          setError(null);
        }}
        placeholder="Password"
        readOnly={submitting}
        type="password"
        value={password}
      />
      <p
        aria-live={error ? undefined : "polite"}
        className="setup-note"
        data-tone={error ? "error" : undefined}
        id="credentials-hint"
        role={error ? "alert" : undefined}
      >
        {error ??
          (signedOut && !password ? (
            SERVER_SIGN_OUT_NOTE
          ) : (
            <>
              Forgot it? Run <code>openteam account update --password</code> on your server.
            </>
          ))}
      </p>
    </SetupLayout>
  );
}
