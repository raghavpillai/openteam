import { Globe } from "lucide-react";
import { useState } from "react";

type FaviconState = "loading" | "loaded" | "missing";
/** Hosts already answered this session, so remounted messages skip the skeleton. */
const settled = new Map<string, Exclude<FaviconState, "loading">>();

const faviconHost = (href: string | undefined) => {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

/**
 * The linked site's icon, served by the main process (`openteam-favicon:`).
 * A pulsing skeleton holds its space while it loads and a globe replaces it
 * when the site has none, so the line never reflows.
 */
export function LinkFavicon({ href }: { href: string | undefined }) {
  const host = faviconHost(href);
  const [state, setState] = useState<FaviconState>(() => (host && settled.get(host)) || "loading");
  if (!host) return null;
  const settle = (next: Exclude<FaviconState, "loading">) => {
    settled.set(host, next);
    setState(next);
  };
  return (
    <span aria-hidden="true" className="link-favicon" data-state={state}>
      {state === "missing" ? (
        <Globe className="link-favicon-fallback" strokeWidth={1.75} />
      ) : (
        <img
          alt=""
          decoding="async"
          draggable={false}
          onError={() => settle("missing")}
          onLoad={() => settle("loaded")}
          src={`openteam-favicon://icon/${encodeURIComponent(host)}`}
        />
      )}
    </span>
  );
}
