import { Check, Link } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../../lib/cn";

export function PluginCopyButton({
  pluginKey,
  compact = false,
}: {
  pluginKey: string;
  compact?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
      clearTimeout(timer.current);
    },
    []
  );
  const copy = async () => {
    const current = ++request.current;
    let next: "copied" | "error";
    try {
      await navigator.clipboard.writeText(
        `openteam://app/v1/plugin/add?id=${encodeURIComponent(pluginKey)}`
      );
      next = "copied";
    } catch {
      next = "error";
    }
    if (current !== request.current) return;
    clearTimeout(timer.current);
    setStatus(next);
    timer.current = setTimeout(() => setStatus("idle"), compact ? 1200 : 2000);
  };
  const label = status === "copied" ? "Copied" : status === "error" ? "Couldn't copy" : "Share";
  return (
    <button
      aria-label={compact ? "Copy link to this plugin" : label}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 text-[13px] outline-none transition-colors duration-120 ease-out focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2",
        compact
          ? "size-5 rounded text-foreground-tertiary opacity-0 transition-opacity group-hover/plugin-heading:opacity-100 focus-visible:opacity-100 hover:text-foreground"
          : "h-9 rounded-full bg-[#77777717] px-4 text-foreground hover:bg-[#7777772b]"
      )}
      title={
        compact
          ? status === "error"
            ? "Couldn't copy link"
            : "Copy link to this plugin"
          : undefined
      }
      onClick={() => void copy()}
      type="button"
    >
      {status === "copied" ? <Check className="size-3.5" /> : <Link className="size-3.5" />}
      {!compact && label}
      <span role="status" className="sr-only">
        {status === "copied"
          ? "Link copied"
          : status === "error"
            ? "Couldn't copy link. Try again."
            : ""}
      </span>
    </button>
  );
}
