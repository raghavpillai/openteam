import { Check, CircleAlert, ExternalLink } from "lucide-react";
import { LoadingOrb } from "../ui/loading-orb";
import { useEffect, useState } from "react";
import type { ModelSetup, ModelTestState } from "../../hooks/use-model-setup";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

export const primaryButton =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-[8px] bg-black px-3 text-[12px] text-white outline-none focus-visible:ring-2 focus-visible:ring-ring/35 enabled:hover:opacity-80 disabled:bg-black/[0.07] disabled:text-foreground disabled:opacity-50 dark:bg-white dark:text-black dark:disabled:bg-white/[0.09] dark:disabled:text-foreground";
export const secondaryButton =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-[8px] bg-black/[0.07] px-3 text-[12px] outline-none hover:bg-black/[0.1] focus-visible:ring-2 focus-visible:ring-ring/35 disabled:opacity-50 dark:bg-white/[0.09] dark:hover:bg-white/[0.13]";
const inputClass =
  "h-8 min-w-0 flex-1 rounded-[8px] border border-black/[0.09] bg-background px-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:border-white/[0.1]";

const openLink = (url: string) => window.open(url, "_blank", "noopener,noreferrer");

/** Shows whatever the provider sign-in needs next: a browser, a code, or a key. */
export function SignInProgress({ setup }: { setup: ModelSetup }) {
  const session = setup.authSession;
  const prompt = session?.prompt;
  const [value, setValue] = useState("");
  useEffect(() => setValue(""), [prompt?.id]);
  if (!session) return null;
  const finished = ["connected", "failed", "cancelled"].includes(session.status);
  const waitingForBrowser =
    !finished && Boolean(session.authorizationUrl) && setup.capture === "waiting";
  // Automatic redirects make the paste box unnecessary unless they're unavailable.
  const showPrompt = prompt && !(prompt.type === "manual_code" && waitingForBrowser);
  const submit = () => void setup.respond(prompt!.id, value.trim());

  return (
    <div className="space-y-2 py-3 text-[12.5px]" data-testid="provider-sign-in">
      {session.status === "connected" ? (
        <div className="flex items-center gap-1.5 text-foreground">
          <Check className="size-3.5 text-emerald-600" /> Connected
        </div>
      ) : session.status === "failed" ? (
        <div className="flex items-start gap-1.5 text-red-600 dark:text-red-400">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{session.error || "The sign-in didn't finish. Try again."}</span>
        </div>
      ) : waitingForBrowser ? (
        <div className="flex items-center gap-2 text-foreground-secondary">
          <LoadingOrb aria-hidden size={14} /> Finish signing in in your browser…
        </div>
      ) : session.deviceCode ? (
        <div className="space-y-1.5">
          <div className="text-foreground-secondary">
            Open the sign-in page and enter this code:
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-[8px] bg-black/[0.05] px-3 py-1.5 font-mono text-[15px] font-medium tracking-wider dark:bg-white/[0.08]">
              {session.deviceCode.userCode}
            </span>
            <button
              className={secondaryButton}
              onClick={() => openLink(session.deviceCode!.verificationUri)}
              type="button"
            >
              Open sign-in page <ExternalLink className="size-3" />
            </button>
          </div>
        </div>
      ) : !prompt ? (
        <div className="flex items-center gap-2 text-foreground-secondary">
          <LoadingOrb aria-hidden size={14} /> Starting sign-in…
        </div>
      ) : null}

      {setup.captureMessage && !finished ? (
        <div className="text-[12px] text-foreground-secondary">
          {setup.captureMessage} After you sign in, copy the address of the page your browser lands
          on and paste it here.
        </div>
      ) : null}
      {session.authorizationUrl && !finished && setup.capture !== "waiting" ? (
        <button
          className="inline-flex items-center gap-1 text-[12px] text-foreground underline underline-offset-2"
          onClick={() => openLink(session.authorizationUrl!)}
          type="button"
        >
          Open sign-in page <ExternalLink className="size-3" />
        </button>
      ) : null}

      {showPrompt && !finished ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {prompt.type === "select" ? (
            <Select onValueChange={setValue} value={value}>
              <SelectTrigger className={`${inputClass} w-auto`}>
                <SelectValue placeholder={prompt.message} />
              </SelectTrigger>
              <SelectContent>
                {(prompt.options ?? []).map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <input
              aria-label={prompt.message}
              autoComplete="off"
              autoFocus
              className={inputClass}
              maxLength={20_000}
              onChange={(event) => setValue(event.target.value)}
              placeholder={
                prompt.type === "secret"
                  ? "Paste your API key"
                  : prompt.type === "manual_code"
                    ? "Paste the address from your browser"
                    : (prompt.placeholder ?? prompt.message)
              }
              type={prompt.type === "secret" ? "password" : "text"}
              value={value}
            />
          )}
          <button
            className={primaryButton}
            disabled={!value.trim() || setup.busy === "respond"}
            type="submit"
          >
            Continue
          </button>
        </form>
      ) : null}

      {!finished ? (
        <button
          className="text-[12px] text-foreground-secondary underline-offset-2 hover:underline"
          onClick={setup.cancelSignIn}
          type="button"
        >
          Cancel
        </button>
      ) : session.status !== "connected" ? (
        <button className={secondaryButton} onClick={setup.clearSignIn} type="button">
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function ModelTestStatus({ test }: { test: ModelTestState }) {
  if (test.status === "idle") return null;
  if (test.status === "running") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[12px] text-foreground-secondary"
        role="status"
      >
        <LoadingOrb aria-hidden size={14} /> Testing the model…
      </span>
    );
  }
  if (test.status === "passed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-foreground" role="status">
        <Check className="size-3.5 text-emerald-600" /> Working · replied in{" "}
        {(test.latencyMs / 1000).toFixed(1)} s
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-start gap-1.5 text-[12px] text-red-600 dark:text-red-400"
      role="alert"
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> {test.error}
    </span>
  );
}
