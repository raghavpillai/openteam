import ipaddr from "ipaddr.js";
import { lookup } from "node:dns/promises";

export function isPublicAddress(value: string): boolean {
  try {
    return ipaddr.process(value).range() === "unicast";
  } catch {
    return false;
  }
}

export function publicWebUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("WebFetch requires an unauthenticated HTTP(S) URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    (ipaddr.isValid(host) && !isPublicAddress(host))
  )
    throw new Error("Private and local network destinations are not allowed");
  return url;
}

export async function validatePublicWebUrl(value: string, signal?: AbortSignal): Promise<URL> {
  signal?.throwIfAborted();
  const url = publicWebUrl(value);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
  signal?.throwIfAborted();
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address)))
    throw new Error("Private and local network destinations are not allowed");
  return url;
}
