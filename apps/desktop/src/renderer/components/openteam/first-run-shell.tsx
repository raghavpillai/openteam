import { lazy, Suspense, useEffect, useState } from "react";
import { API_BASE } from "../../client/http";
import { TIMEOUT_MESSAGE } from "../../lib/request-errors";

/** True until setup has finished for the server (App.tsx keeps the same flag). */
export const isFirstRun = (apiBase: string = API_BASE): boolean => {
  try {
    return localStorage.getItem(`openteam:onboarding-finished:${apiBase}`) !== "1";
  } catch {
    return false;
  }
};

/**
 * Reloads into the server at `apiBase`. When setup comes next, the URL carries
 * #openteam-setup-frame so the boot screen draws setup's frame from the first paint
 * (index.html) and the window doesn't blank in between.
 */
export function reloadInto(apiBase: string) {
  if (isFirstRun(apiBase)) window.location.hash = "openteam-setup-frame";
  window.location.reload();
}

// The server check's opening state, from the setup screens' chunk (loaded early on a first
// run, since setup comes next anyway).
const ServerCheckPreview = lazy(() =>
  import("./onboarding").then((module) => ({ default: module.ServerCheckPreview }))
);

// When the server check first showed, across the frames that replace each other between
// signing in and setup, and how long it waits before saying the server is slow to answer
// (as long as the real check waits before saying something isn't running).
let checkingSince: number | null = null;
const PATIENCE_MS = 15_000;
const patienceLeft = () => PATIENCE_MS - (performance.now() - (checkingSince ?? performance.now()));

/**
 * What a first run shows while it loads, so sign-in, the reload that follows it and the
 * server check read as one flow. With `serverCheck` (someone is signed in) it is the
 * server check as it first looks; the real check then continues from it without moving.
 * Until that loads, and before sign-in, it is setup's empty frame: the panel, its progress
 * bar on the first step and the stage's tint, in inline styles because setup.css loads
 * with the setup screens.
 *
 * If the server can't be loaded (`problem`), or says nothing for a while, the check says
 * so, and Check again runs `onRetry` (by default, loading the app again).
 */
export function FirstRunShell({
  serverCheck = false,
  problem = null,
  onRetry,
}: {
  serverCheck?: boolean;
  problem?: string | null;
  onRetry?: () => unknown;
}) {
  if (serverCheck) checkingSince ??= performance.now();
  const [late, setLate] = useState(() => serverCheck && patienceLeft() <= 0);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    if (!serverCheck || late) return;
    const timer = window.setTimeout(() => setLate(true), Math.max(0, patienceLeft()));
    return () => window.clearTimeout(timer);
  }, [serverCheck, late]);

  if (!serverCheck) return <EmptyFrame />;
  const retry = () => {
    if (!onRetry) return reloadInto(API_BASE);
    if (retrying) return;
    checkingSince = performance.now();
    setLate(false);
    setRetrying(true);
    // Busy at least briefly, so the press visibly did something.
    const pause = new Promise((resolve) => window.setTimeout(resolve, 700));
    void Promise.allSettled([onRetry(), pause]).then(() => setRetrying(false));
  };
  return (
    <Suspense fallback={<EmptyFrame />}>
      <ServerCheckPreview
        onRetry={retry}
        problem={problem ?? (late ? TIMEOUT_MESSAGE : null)}
        retrying={retrying}
      />
    </Suspense>
  );
}

function EmptyFrame() {
  // The setup screens pick up from here instead of filling the first segment again.
  document.documentElement.dataset.setupProgress = "0";
  const dark = document.documentElement.dataset.theme === "dark";
  const wide = window.innerWidth > 860;
  const ink = dark ? "#f4f4f6" : "#111113";
  const line = dark ? "rgb(255 255 255 / 10%)" : "rgb(17 17 19 / 10%)";
  return (
    <main
      aria-busy="true"
      aria-label="Loading"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        background: dark ? "#121214" : "#ffffff",
      }}
    >
      <div className="electron-window-drag-strip" />
      <section
        style={{
          width: wide ? "clamp(400px, 40vw, 500px)" : "100%",
          flexShrink: 0,
          padding: `${window.innerHeight <= 640 ? 32 : 56}px 48px 40px`,
          boxShadow: wide ? `1px 0 0 ${line}` : "none",
        }}
      >
        <div
          style={{
            display: "grid",
            maxWidth: wide ? undefined : 440,
            margin: wide ? undefined : "0 auto",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 6,
          }}
        >
          {[0, 1, 2, 3].map((index) => (
            <span
              key={index}
              style={{ height: 4, borderRadius: 4, background: index === 0 ? ink : line }}
            />
          ))}
        </div>
      </section>
      {wide ? (
        <div
          style={{
            flex: 1,
            background: dark
              ? "radial-gradient(circle at 50% 42%, #172338, transparent 62%), #111a29"
              : "radial-gradient(circle at 50% 42%, #dfe8f8, transparent 62%), #edf2fb",
          }}
        />
      ) : null}
    </main>
  );
}
