"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/copy-text";

export function CopyPage({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await copyText(markdown);
      setCopied(true);
      toast.success("Page copied as Markdown");
    } catch {
      setCopied(false);
      toast.error("Couldn't copy page. Please try again.");
    }
  }

  return (
    <Button type="button" variant="outline" className="docs-copy" data-copied={copied || undefined} onClick={copy}>
      <span key={String(copied)} className="docs-copy-icon">
        {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      </span>
      {copied ? "Copied" : "Copy page"}
    </Button>
  );
}
