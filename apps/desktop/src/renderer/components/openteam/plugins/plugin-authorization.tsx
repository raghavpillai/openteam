import type { PluginConnectionView } from "@openteam/contracts";
import { pluginAuthorization } from "@openteam/product-core/plugin-authorization";
import { api } from "../../../client/openteam-api";
import { useEffect, useState } from "react";

/** Manual sign-in stays in OpenTeam until the user has read the copy/paste steps. */
export function openAutomaticPluginSignIn(callbackMode: string | undefined, url: string) {
  if (callbackMode !== "manual") window.open(url, "_blank", "noopener,noreferrer");
}

export function PluginAuthorization({
  connection,
  busy,
  onCancel,
  onRetry,
}: {
  connection: PluginConnectionView;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const [callbackUrl, setCallbackUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [openedBrowser, setOpenedBrowser] = useState(false);
  useEffect(() => { setCallbackUrl(""); setFeedback(""); setOpenedBrowser(false); }, [connection.id, connection.authorizationUrl]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!connection.authorizationUrl) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [connection.authorizationUrl]);
  const session = pluginAuthorization(connection, now);
  useEffect(() => { if (session?.expired) setCallbackUrl(""); }, [session?.expired]);
  if (!session) return null;
  const manual = connection.oauthCallbackMode === "manual";
  const google = ["gmail", "google-calendar", "google-drive"].includes(connection.pluginKey);
  const finish = async () => {
    if (submitting) return;
    const value = callbackUrl; setCallbackUrl(""); setSubmitting(true); setFeedback("");
    try {
      await api.finishManualPluginAuthentication(connection.id, value);
      setFeedback("Authorization received. Refreshing connection status…");
    } catch {
      const status = await api.pluginConnectionStatuses([connection.id]).catch(() => null);
      setFeedback(status?.connections[0]?.status === "ready" ? "Connected." : "Could not finish sign-in. Copy the entire address from the browser’s final page and try pasting it again. If this sign-in expired, start again.");
    } finally { setSubmitting(false); }
  };
  const action =
    "inline-flex items-center rounded-full bg-foreground/[0.06] px-3 py-1 text-[12px] hover:bg-foreground/[0.1] disabled:opacity-40";
  return (
    <div className="mx-3 mb-3 rounded-lg bg-foreground/[0.035] p-3" role="status">
      <p className="text-[12px] font-medium">
        {session.expired ? "Sign-in expired" : manual && !openedBrowser ? "Before you sign in" : "Finish signing in"}
      </p>
      {manual && !session.expired ? <ol className="mt-2 list-decimal space-y-2 pl-4 text-[12px] text-foreground-secondary">
        <li>Sign in{google ? " to Google" : " in your browser"} and approve access.</li>
        <li>The browser may say it can’t open the page. That’s expected. Copy the entire address starting with 127.0.0.1 from the address bar.</li>
        <li>Return to OpenTeam, paste the address below, then select Complete sign-in.</li>
      </ol> : <p className="mt-1 text-[11px] text-foreground-secondary">
        {session.expired
          ? "Start again when you’re ready. Your setup is saved."
          : "Finish in your browser. If you closed it, reopen the same sign-in below."}
      </p>}
      {manual && !session.expired && <div className="mt-3 flex flex-wrap gap-2">
        <input type="password" aria-label="Browser address from sign-in" placeholder="Paste the browser address here" autoComplete="off" spellCheck={false} value={callbackUrl} onChange={event => setCallbackUrl(event.target.value)} className="min-w-0 flex-1 rounded border border-foreground/15 bg-transparent px-3 py-2 text-[12px]" />
        <button className={action} type="button" disabled={busy || submitting || !callbackUrl.trim()} onClick={() => void finish()}>Complete sign-in</button>
      </div>}
      {feedback && <p role="status" className="mt-2 text-[12px]">{feedback}</p>}
      <div className="mt-2 flex gap-2">
        {session.expired ? (
          <button className={action} type="button" disabled={busy || submitting} onClick={onRetry}>
            Try again
          </button>
        ) : manual ? (
          <button className={action} type="button" disabled={busy || submitting} onClick={() => {
            window.open(session.url, "_blank", "noopener,noreferrer");
            setOpenedBrowser(true);
          }}>
            {openedBrowser ? "Reopen sign-in" : google ? "Continue to Google" : "Continue to browser"}
          </button>
        ) : window.openteam?.pluginOAuth ? (
          <button className={action} type="button" disabled={busy || submitting} onClick={onRetry}>
            Reopen sign-in
          </button>
        ) : (
          <a className={action} href={session.url} target="_blank" rel="noopener noreferrer">
            Reopen sign-in
          </a>
        )}
        <button className={action} type="button" disabled={busy || submitting} onClick={onCancel}>
          Cancel sign-in
        </button>
      </div>
    </div>
  );
}
