import { Puzzle } from "lucide-react";
import { useState } from "react";
import { cn } from "../../../lib/cn";

export function PluginMark({
  logoUrl,
  name,
  size = "md",
}: {
  logoUrl?: string | null;
  name: string;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = Boolean(logoUrl && logoUrl !== failedUrl);
  return (
    <span
      aria-hidden="true"
      data-plugin-icon={name}
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-[10px] border border-black/[0.08] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] dark:border-white/[0.12]",
        size === "xs" && "size-6 rounded-[7px]",
        size === "sm" && "size-8 rounded-[8px]",
        size === "md" && "size-10",
        size === "lg" && "size-14 rounded-[13px]",
        !showImage && "bg-black/[0.045] text-foreground-secondary dark:bg-[#303030]"
      )}
    >
      {showImage ? (
        <img
          key={logoUrl}
          alt=""
          className="size-[80%] object-contain"
          src={logoUrl!}
          onError={() => setFailedUrl(logoUrl!)}
        />
      ) : (
        <Puzzle data-icon-fallback className="size-[54%]" strokeWidth={1.7} />
      )}
    </span>
  );
}
