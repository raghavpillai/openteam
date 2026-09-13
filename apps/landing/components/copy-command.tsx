"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/copy-text";

export function CopyCommand({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copy = async () => {
    try {
      await copyText(command);
      setCopied(true);
      toast.success("Copied to clipboard");
    } catch {
      setCopied(false);
      toast.error("Couldn't copy command");
    }
  };

  return (
    <div className="dl-command">
      <span aria-hidden="true" className="dl-command-prompt">
        $
      </span>
      <code>{command}</code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="dl-copy"
        onClick={copy}
        aria-label={copied ? "Copied" : (label ?? `Copy ${command}`)}
      >
        {copied ? <Check /> : <Copy />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </Button>
    </div>
  );
}
