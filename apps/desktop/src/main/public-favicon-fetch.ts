import { lookup } from "node:dns/promises";
import { createPublicHttpFetch, publicHttpLookup } from "@openteam/plugin-sdk/public-http";

// Keep the favicon API and its HTTP support/HTML and image limits intact.
export const publicFaviconLookup = publicHttpLookup;
export function createPublicFaviconFetch(resolve = lookup) {
  return createPublicHttpFetch({ resolve });
}
