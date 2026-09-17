"use client";

import { Check, Copy } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/copy-text";

const COMMAND_PARTS = ["curl -fsSL", "https://openteam.so/install", "| sh"];
export const INSTALL_COMMAND = COMMAND_PARTS.join(" ");

export function InstallCommand() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await copyText(INSTALL_COMMAND);
      setCopied(true);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Couldn't copy command");
    }
  };

  return (
    <div className="ot-install-terminal">
      <div className="ot-install-command-toolbar">
        <span className="ot-install-terminal-title">
          <span className="ot-install-window-dots" aria-hidden="true"><i /><i /><i /></span>
          Terminal
        </span>
        <span className="ot-install-platform">macOS &amp; Linux</span>
      </div>
      <div className="ot-install-command-line">
        <div className="ot-install-code">
          <span aria-hidden="true" className="ot-install-prompt">$</span>
          <code>
            {COMMAND_PARTS.map((part, index) => (
              <Fragment key={part}>
                {index > 0 ? " " : null}<span>{part}</span>
              </Fragment>
            ))}
          </code>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={copy}
          aria-live="polite"
          aria-label={copied ? "Copied" : "Copy install command"}
          data-copied={copied ? "" : undefined}
          className="ot-install-copy"
        >
          {copied ? <Check /> : <Copy />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
    </div>
  );
}
