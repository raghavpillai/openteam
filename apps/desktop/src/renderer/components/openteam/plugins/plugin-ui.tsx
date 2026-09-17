import { useRef, useState, type ReactNode } from "react";
import { api } from "../../../client/openteam-api";
import { clientErrorMessage } from "@openteam/product-core/redaction";

export const inputClass =
  "w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40 dark:border-white/15";
export function PluginButton({
  children,
  onClick,
  disabled = false,
  primary = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-40 ${primary ? "bg-foreground text-background" : "bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"}`}
    >
      {children}
    </button>
  );
}
export function PluginField({
  label,
  children,
  help,
}: {
  label: string;
  children: ReactNode;
  help?: string | null;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {help && <span className="text-xs text-foreground-secondary">{help}</span>}
    </label>
  );
}
export function usePluginOperation(refresh: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = async (
    action: () => Promise<unknown>,
    success?: string,
    options: { refreshAfter?: boolean } = {}
  ) => {
    if (active.current) return false;
    active.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      if (options.refreshAfter !== false) {
        await refresh();
        window.dispatchEvent(new Event("openteam:plugins-changed"));
      }
      if (success) setMessage(success);
      return true;
    } catch (cause) {
      if (options.refreshAfter !== false) await refresh().catch(() => undefined);
      setError(clientErrorMessage(cause, "Plugin operation failed"));
      return false;
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return {
    busy,
    error,
    message,
    run,
    feedback: (
      <>
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-300"
          >
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm text-green-700 dark:text-green-300">
            {message}
          </p>
        )}
      </>
    ),
  };
}
export async function downloadPlugin(id: string, draft = false) {
  const bundle = await api.exportPlugin(id, draft);
  const bytes = Uint8Array.from(atob(bundle.base64), (value) => value.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = bundle.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
