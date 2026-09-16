import { DOCS_ORIGIN, type DocsTextData } from "./docs-types";

export const docsDiscoveryHeaders = {
  Link: '</llms.txt>; rel="llms-txt", </llms-full.txt>; rel="llms-full-txt", </docs/llms.txt>; rel="describedby"',
  "X-Llms-Txt": "/llms.txt",
  Vary: "Accept, RSC",
};

/** Only explicit Markdown/plain preferences opt in; wildcards still get HTML. */
export function preferredTextType(accept: string | null): string | undefined {
  const ranges = (accept ?? "").toLowerCase().split(",").map((range) => {
    const [type, ...parameters] = range.trim().split(";");
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return { type: type.trim(), q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0 };
  });
  const html = ranges.find(({ type }) => type === "text/html")
    ?? ranges.find(({ type }) => type === "text/*")
    ?? ranges.find(({ type }) => type === "*/*");
  const text = ranges.filter(({ type, q }) => (type === "text/markdown" || type === "text/plain") && q > 0)
    .sort((a, b) => b.q - a.q)[0];
  return text && text.q >= (html?.q ?? 0) ? text.type : undefined;
}

/** No filesystem, Markdown parser, or external fetch is used at request time. */
export function docsTextResponse(request: Request, data: DocsTextData): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return;
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/$/, "");
  const index = /^(?:\/docs)?(?:\/\.well-known)?\/(llms(?:-full)?\.txt)$/.exec(pathname);
  const explicit = pathname === "/docs.md" || (pathname.startsWith("/docs/") && pathname.endsWith(".md"));
  const isDocs = pathname === "/docs" || pathname.startsWith("/docs/");
  // Never turn the router's RSC/prefetch traffic into Markdown.
  const negotiated = isDocs && request.headers.get("RSC") !== "1" && preferredTextType(request.headers.get("Accept"));
  if (!index && !explicit && !negotiated) return;

  let body: string | undefined;
  if (index) body = index[1] === "llms.txt" ? data.index : data.full;
  else {
    const page = data.pages[explicit ? pathname.slice(0, -3) : pathname];
    if (page !== undefined) body = `> ## Documentation index\n> Browse all guides: ${DOCS_ORIGIN}/llms.txt\n\n${page}`;
  }
  const found = body !== undefined;
  const headers = new Headers(docsDiscoveryHeaders);
  headers.set("Content-Type", `${index ? "text/plain" : negotiated || "text/markdown"}; charset=utf-8`);
  headers.set("Cache-Control", found ? "public, max-age=0, must-revalidate" : "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  if (!index) headers.set("X-Robots-Tag", "noindex, nofollow");
  if (explicit || negotiated) headers.append("Link", `<${pathname.replace(/\.md$/, "")}>; rel="canonical"`);
  return new Response(request.method === "HEAD" ? null : (body ?? "# Page not found\n\nBrowse /llms.txt for available documentation.\n").replaceAll(DOCS_ORIGIN, url.origin), {
    status: found ? 200 : 404,
    headers,
  });
}
