import type { ReactNode } from "react";
import { lazy, Suspense, useEffect, useState } from "react";
import { refreshAuthSession } from "../../client/auth";
import { useAuthSession } from "../../hooks/use-auth-session";
import { LoadingOrb } from "../ui/loading-orb";
import { FirstRunShell, isFirstRun } from "./first-run-shell";

// Sign-in screens load only when someone is signed out, keeping them out of every launch.
const SignInFlow = lazy(() => import("./sign-in-flow"));

function Checking({ signedIn = false }: { signedIn?: boolean }) {
  // A first run shows setup's frame, so what comes next fades in on a frame that is already
  // there: the server check when someone is signed in, otherwise the sign-in screens.
  // Returning launches keep the plain spinner.
  if (isFirstRun()) return <FirstRunShell serverCheck={signedIn} />;
  return (
    <main
      aria-live="polite"
      className="grid h-screen place-items-center bg-background text-muted-foreground"
      role="status"
    >
      <div className="electron-window-drag-strip" />
      <LoadingOrb label="Checking session" size={20} />
    </main>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuthSession();
  // Once shown, the sign-in screens stay mounted while a new session is being verified.
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    void refreshAuthSession();
  }, []);

  useEffect(() => {
    if (auth.status === "signed-out") setSigningIn(true);
  }, [auth.status]);

  if (auth.status === "authenticated") return children;
  if (!signingIn) return <Checking signedIn={Boolean(auth.user)} />;
  return (
    <Suspense fallback={<Checking />}>
      <SignInFlow auth={auth} />
    </Suspense>
  );
}
