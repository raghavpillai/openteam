import { useState } from "react";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { api } from "../../../client/openteam-api";
import { OPENTEAM_DEEP_LINK_EVENT } from "../../../lib/app-deep-links";

/** Resolve current plugin state instead of reopening a stale URL saved in a chat receipt. */
export function PluginApprovalNextStep({ details }: { details: Record<string, unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const open = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const args =
        details.arguments && typeof details.arguments === "object"
          ? (details.arguments as Record<string, unknown>)
          : {};
      const result =
        details.actionResult && typeof details.actionResult === "object"
          ? (details.actionResult as Record<string, unknown>)
          : {};
      let pluginId = typeof args.pluginKey === "string" ? args.pluginKey : null;
      if (!pluginId) {
        const settings = await api.pluginSettings();
        const connectionId = result.connectionId ?? args.connectionId;
        pluginId =
          settings.installs.find((install) =>
            install.connections.some((connection) => connection.id === connectionId)
          )?.pluginKey ?? null;
      }
      if (!pluginId)
        throw new Error(
          "This connection is no longer installed. Open Marketplace to install it again."
        );
      window.dispatchEvent(
        new CustomEvent(OPENTEAM_DEEP_LINK_EVENT, {
          detail: { url: `openteam://app/v1/plugin/add?id=${encodeURIComponent(pluginId)}` },
        })
      );
    } catch (cause) {
      setError(clientErrorMessage(cause, "Open the plugin in Marketplace to continue."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 space-y-2">
      {typeof details.actionError === "string" ? (
        <p role="alert" className="text-xs text-destructive">
          {clientErrorMessage(
            new Error(details.actionError),
            "The plugin action failed. Open its settings to try again."
          )}
        </p>
      ) : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => void open()}
        className="rounded-lg border border-foreground/10 px-3 py-1.5 text-xs disabled:opacity-50"
      >
        {busy ? "Opening…" : "Open plugin setup"}
      </button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
