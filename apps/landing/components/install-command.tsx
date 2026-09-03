"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "./icons";

export const INSTALL_COMMAND = "bunx --bun @openteam/cli install";

export function InstallCommand({ size = "lg" }: { size?: "lg" | "md" }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
    } catch {
      // Clipboard can be unavailable in some contexts; the command is selectable text anyway.
    }
  };

  const large = size === "lg";
  return (
    <div
      className={`inline-flex max-w-full items-center gap-2.5 rounded-xl border border-line-strong bg-surface pl-3.5 shadow-card sm:gap-3 sm:pl-4 ${
        large ? "h-13 pr-1.5 text-[13px] sm:text-[15px]" : "h-11 pr-1 text-[13.5px]"
      }`}
    >
      <span aria-hidden="true" className="font-mono text-ink-3 select-none">
        $
      </span>
      <code className="truncate font-mono text-ink">{INSTALL_COMMAND}</code>
      <button
        type="button"
        onClick={copy}
        aria-live="polite"
        aria-label={copied ? "Copied" : "Copy install command"}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg font-medium transition-colors ${
          large ? "h-10 px-2.5 text-[13px] sm:px-3" : "h-8 px-2.5 text-[12.5px]"
        } ${copied ? "bg-live-soft text-[#0b7a4b]" : "bg-raised text-ink-2 hover:bg-sunken hover:text-ink"}`}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        <span className={large ? "hidden sm:inline" : ""}>{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
