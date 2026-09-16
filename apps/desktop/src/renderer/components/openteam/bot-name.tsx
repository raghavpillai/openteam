import type { BotView } from "@openteam/contracts";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api } from "../../client/openteam-api";

export const BotRenameContext = createContext<{
  bot: BotView;
  active: boolean;
  finish: () => void;
} | null>(null);

/** Inline names also work in pinned tiles; no profile panel or modal is opened. */
export function BotName({ name }: { name: string }) {
  const rename = useContext(BotRenameContext);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const canceled = useRef(false);
  useEffect(() => {
    if (!rename?.active) return;
    canceled.current = false;
    setDraft(name);
    setError("");
    const frame = requestAnimationFrame(() => input.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [rename?.active, name]);
  if (!rename?.active) return <>{name}</>;
  const save = async () => {
    if (submitting.current || canceled.current) return;
    if (!draft.trim() || draft.trim() === name) {
      rename.finish();
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await api.updateBot(rename.bot.id, { name: draft.trim() });
      rename.finish();
    } catch {
      setError("Could not rename. Press Enter to retry.");
      input.current?.focus();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <input
        ref={input}
        aria-label="Rename Bot"
        aria-invalid={Boolean(error)}
        title={error || undefined}
        className="w-full min-w-0 border-0 bg-transparent p-0 font-[inherit] leading-[inherit] text-foreground outline-none selection:bg-[#afd3f5] selection:text-[#141414]"
        value={draft}
        maxLength={120}
        readOnly={busy}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void save()}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            if (!submitting.current) {
              canceled.current = true;
              rename.finish();
            }
          }
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          }
        }}
      />
      {error && (
        <span role="alert" className="sr-only">
          {error}
        </span>
      )}
    </>
  );
}
