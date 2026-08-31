import { LoaderCircle, LockKeyhole } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { AUTH_REQUIRED_EVENT, clearAuthToken, hasValidSession, signIn } from "../../client/auth";
import { Button } from "../ui/button";

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "signed-out" | "signed-in">("checking");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void hasValidSession().then((valid) => {
      if (cancelled) return;
      if (!valid) clearAuthToken();
      setState(valid ? "signed-in" : "signed-out");
    });
    const requireAuth = () => setState("signed-out");
    window.addEventListener(AUTH_REQUIRED_EVENT, requireAuth);
    return () => {
      cancelled = true;
      window.removeEventListener(AUTH_REQUIRED_EVENT, requireAuth);
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await signIn(username, password);
      setPassword("");
      setState("signed-in");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in to OpenBot");
    } finally {
      setSubmitting(false);
    }
  };

  if (state === "signed-in") return children;

  return (
    <main className="grid min-h-screen place-items-center bg-[#f5f5f3] px-6 text-[#20201e]">
      {state === "checking" ? (
        <LoaderCircle aria-label="Checking OpenBot session" className="size-6 animate-spin" />
      ) : (
        <form
          className="w-full max-w-[360px] rounded-2xl border border-black/10 bg-white p-7 shadow-sm"
          onSubmit={(event) => void submit(event)}
        >
          <div className="mb-6 grid size-11 place-items-center rounded-xl bg-[#20201e] text-white">
            <LockKeyhole className="size-5" strokeWidth={1.8} />
          </div>
          <h1 className="text-xl font-semibold tracking-[-0.02em]">Sign in to OpenBot</h1>
          <p className="mt-1 text-sm text-black/55">
            Use the username and password created by <code>openbot setup</code>.
          </p>
          <label className="mt-6 block text-xs font-medium text-black/65" htmlFor="username">
            Username
          </label>
          <input
            autoCapitalize="none"
            autoComplete="username"
            autoFocus
            className="mt-1.5 h-10 w-full rounded-lg border border-black/15 bg-white px-3 text-sm outline-none focus:border-black/45"
            id="username"
            onChange={(event) => setUsername(event.target.value)}
            spellCheck={false}
            value={username}
          />
          <label className="mt-4 block text-xs font-medium text-black/65" htmlFor="password">
            Password
          </label>
          <input
            autoComplete="current-password"
            className="mt-1.5 h-10 w-full rounded-lg border border-black/15 bg-white px-3 text-sm outline-none focus:border-black/45"
            id="password"
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
          {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
          <Button className="mt-5 w-full" disabled={submitting} type="submit">
            {submitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Sign in
          </Button>
        </form>
      )}
    </main>
  );
}
