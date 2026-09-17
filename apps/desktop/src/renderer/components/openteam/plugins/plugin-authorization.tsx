import type { PluginConnectionView } from "@openteam/contracts";
import { pluginAuthorization } from "@openteam/product-core/plugin-authorization";
import { useEffect, useState } from "react";

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
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!connection.authorizationUrl) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [connection.authorizationUrl]);
  const session = pluginAuthorization(connection, now);
  if (!session) return null;
  const action =
    "inline-flex items-center rounded-full bg-foreground/[0.06] px-3 py-1 text-[12px] hover:bg-foreground/[0.1] disabled:opacity-40";
  return (
    <div className="mx-3 mb-3 rounded-lg bg-foreground/[0.035] p-3" role="status">
      <p className="text-[12px] font-medium">
        {session.expired ? "Sign-in expired" : "Waiting for authorization"}
      </p>
      <p className="mt-1 text-[11px] text-foreground-secondary">
        {session.expired
          ? "Start again when you’re ready. Your setup is saved."
          : "Finish in your browser. If you closed it, reopen the same sign-in below."}
      </p>
      <div className="mt-2 flex gap-2">
        {session.expired ? (
          <button className={action} type="button" disabled={busy} onClick={onRetry}>
            Try again
          </button>
        ) : (
          <a className={action} href={session.url} target="_blank" rel="noopener noreferrer">
            Reopen sign-in
          </a>
        )}
        <button className={action} type="button" disabled={busy} onClick={onCancel}>
          Cancel sign-in
        </button>
      </div>
    </div>
  );
}
