import { NextResponse, type NextRequest } from "next/server";
import text from "./.generated/docs-text.json";
import { docsDiscoveryHeaders, docsTextResponse } from "./lib/docs-http";

export function proxy(request: NextRequest) {
  const markdown = docsTextResponse(request, text);
  if (markdown) return markdown;
  const headers = new Headers(docsDiscoveryHeaders);
  const pathname = new URL(request.url).pathname.replace(/\/$/, "");
  if (Object.hasOwn(text.pages, pathname)) {
    headers.append("Link", `<${pathname}.md>; rel="alternate"; type="text/markdown"`);
  }
  return NextResponse.next({ headers });
}

export const config = {
  matcher: ["/docs", "/docs.md", "/docs/:path*", "/llms.txt", "/llms-full.txt", "/.well-known/llms.txt", "/.well-known/llms-full.txt"],
};
