import { ArrowRight, LoaderCircle } from "lucide-react";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { refreshAuthSession, signIn } from "../../client/auth";
import { useAuthSession } from "../../hooks/use-auth-session";
import { Button } from "../ui/button";
import { VersionMismatchBanner } from "./version-mismatch-banner";

function OpenBotMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-16 shrink-0 text-foreground max-[520px]:size-12"
      viewBox="0 0 40 40"
    >
      <path
        d="M15 2.8C10.4 3.5 5.1 7 2.3 12 .5 16.5.5 23.8 2.8 27.5 5 32 10.5 34.5 16.5 36.3c4.2 1.05 9.5 1.05 13.5-.2 5.8-2.4 7.6-7 8.4-11.4C39.1 19 36.5 12 32.5 7.5 30.3 3 25 1.5 15 2.8Z"
        fill="currentColor"
        transform="matrix(.995 0 0 .99 .1 .2)"
      />
      <g fill="var(--background)">
        <rect
          height="6.4"
          rx="1.875"
          transform="rotate(-16 21.05 15.8)"
          width="3.75"
          x="19.075"
          y="12.6"
        />
        <rect
          height="6.4"
          rx="1.45"
          transform="rotate(-16 31.7 14.5)"
          width="2.9"
          x="30.25"
          y="11.3"
        />
      </g>
    </svg>
  );
}

function LandingShell({ children }: { children: ReactNode }) {
  return (
    <main className="fixed inset-0 grid place-items-center overflow-hidden bg-background px-6 text-foreground">
      <VersionMismatchBanner showReview={false} />
      <div className="electron-window-drag-strip" />
      <section
        aria-labelledby="openbot-auth-heading"
        className="flex translate-y-10 flex-col items-center max-[520px]:translate-y-6"
      >
        <div className="relative mb-12 flex items-center gap-[18px] max-[520px]:mb-9 max-[520px]:gap-3">
          <OpenBotMark />
          <h1
            className="m-0 text-[68px] leading-[48px] font-medium tracking-[-0.68px] max-[520px]:text-[48px] max-[520px]:leading-[42px]"
            id="openbot-auth-heading"
          >
            OpenBot
          </h1>
        </div>
        <p className="mb-10 max-w-[336px] text-center text-[22px] leading-[1.2] font-normal text-foreground max-[520px]:mb-8 max-[520px]:text-[19px]">
          Your team of always-on Bots that you can give real work to.
        </p>
        <div className="flex min-h-24 w-full flex-col items-center justify-start">{children}</div>
      </section>
    </main>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuthSession();
  const [showCredentials, setShowCredentials] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
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
      await signIn(username, password);
      setPassword("");
    } catch (cause) {
      setError(clientErrorMessage(cause, "Could not sign in to OpenBot"));
    } finally {
      setSubmitting(false);
    }
  };

  if (auth.status === "authenticated") return children;

  if (auth.status === "checking") {
    return (
      <LandingShell>
        <div
          aria-live="polite"
          className="flex h-10 items-center gap-2 text-sm text-foreground-secondary"
        >
          <LoaderCircle className="size-4 animate-spin" />
          Checking session…
        </div>
      </LandingShell>
    );
  }

  return (
    <LandingShell>
      {showCredentials ? (
        <form
          className="electron-no-drag flex w-[min(336px,calc(100vw-48px))] flex-col gap-2.5"
          onSubmit={(event) => void submit(event)}
        >
          <label className="sr-only" htmlFor="username">
            Username
          </label>
          <input
            autoCapitalize="none"
            autoComplete="username"
            className="h-10 w-full rounded-full border border-input bg-field px-5 text-[15px] text-foreground outline-none transition-colors placeholder:text-foreground-tertiary hover:border-foreground-tertiary focus:border-foreground-secondary"
            id="username"
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Username"
            spellCheck={false}
            value={username}
          />
          <label className="sr-only" htmlFor="password">
            Password
          </label>
          <input
            autoComplete="current-password"
            className="h-10 w-full rounded-full border border-input bg-field px-5 text-[15px] text-foreground outline-none transition-colors placeholder:text-foreground-tertiary hover:border-foreground-tertiary focus:border-foreground-secondary"
            id="password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
            type="password"
            value={password}
          />
          {error ? (
            <p aria-live="polite" className="m-0 px-2 text-center text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="mt-1.5 flex items-center justify-center gap-2">
            <Button
              className="h-10 rounded-full px-5 text-[15px] shadow-none"
              disabled={submitting}
              onClick={() => {
                setError(null);
                setPassword("");
                setShowCredentials(false);
              }}
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
            <Button
              className="h-10 rounded-full px-6 text-[15px] shadow-none"
              disabled={submitting || !username.trim() || !password}
              type="submit"
            >
              {submitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
              Sign in
              {submitting ? null : <ArrowRight className="size-4" />}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          className="electron-no-drag h-10 gap-[5px] rounded-full px-6 text-lg font-medium shadow-none"
          onClick={() => setShowCredentials(true)}
          type="button"
        >
          Sign in
          <ArrowRight className="size-[18px]" />
        </Button>
      )}
    </LandingShell>
  );
}
