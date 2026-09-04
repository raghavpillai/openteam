"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      toast.success("Copied to clipboard");
    } catch {
      setCopied(false);
      toast.error("Couldn't copy command");
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-line bg-raised px-3 py-2.5 sm:px-4">
      <span aria-hidden="true" className="font-mono text-[13px] text-ink-3">
        $
      </span>
      <code className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-[13px] whitespace-nowrap text-ink sm:text-[14px]">
        {command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 shrink-0 px-2.5 text-ink-2"
        onClick={copy}
        aria-label={copied ? "Copied" : `Copy ${command}`}
      >
        {copied ? <Check /> : <Copy />}
        <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
      </Button>
    </div>
  );
}
