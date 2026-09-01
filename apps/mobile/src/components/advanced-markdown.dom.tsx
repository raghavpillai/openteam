"use dom";

import DOMPurify from "dompurify";
import katex from "katex";
import { marked } from "marked";
import mermaid from "mermaid";
import { useEffect, useMemo, useRef, useState } from "react";

const mathExtensions = [
  {
    name: "blockMath",
    level: "block" as const,
    start(source: string) {
      return source.indexOf("$$");
    },
    tokenizer(source: string) {
      const match = /^\$\$\s*([\s\S]+?)\s*\$\$(?:\n|$)/.exec(source);
      return match
        ? { type: "blockMath", raw: match[0], text: match[1] ?? "", displayMode: true }
        : undefined;
    },
    renderer(token: { text: string }) {
      return katex.renderToString(token.text, {
        displayMode: true,
        output: "mathml",
        throwOnError: false,
        strict: "warn",
        trust: false,
      });
    },
  },
  {
    name: "inlineMath",
    level: "inline" as const,
    start(source: string) {
      return source.indexOf("$");
    },
    tokenizer(source: string) {
      const match = /^\$(?!\$)([^\n$]+?)\$(?!\$)/.exec(source);
      return match
        ? { type: "inlineMath", raw: match[0], text: match[1] ?? "", displayMode: false }
        : undefined;
    },
    renderer(token: { text: string }) {
      return katex.renderToString(token.text, {
        displayMode: false,
        output: "mathml",
        throwOnError: false,
        strict: "warn",
        trust: false,
      });
    },
  },
];

marked.use({ breaks: true, gfm: true, extensions: mathExtensions });

const sanitizedMarkdown = (content: string): string =>
  DOMPurify.sanitize(marked.parse(content) as string, {
    USE_PROFILES: { html: true, mathMl: true, svg: true, svgFilters: true },
  });

export default function AdvancedMarkdown({
  content,
  dark,
  textColor,
  mutedColor,
  surfaceColor,
  borderColor,
  onOpenLink,
}: {
  content: string;
  dark: boolean;
  textColor: string;
  mutedColor: string;
  surfaceColor: string;
  borderColor: string;
  onOpenLink: (url: string) => Promise<void>;
  dom?: import("expo/dom").DOMProps;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const html = useMemo(() => sanitizedMarkdown(content), [content]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest("a") : null;
      const href = target?.getAttribute("href");
      if (!href || !/^(?:https?:|mailto:)/i.test(href)) return;
      event.preventDefault();
      void onOpenLink(href);
    };
    element.addEventListener("click", onClick);
    return () => element.removeEventListener("click", onClick);
  }, [onOpenLink]);

  useEffect(() => {
    const element = root.current;
    if (!element || html.length === 0) return;
    const diagrams = [...element.querySelectorAll<HTMLElement>("code.language-mermaid")];
    if (diagrams.length === 0) return;
    setRenderError(null);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "neutral",
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    });
    for (const diagram of diagrams) {
      const pre = diagram.closest("pre");
      if (!pre) continue;
      diagram.removeAttribute("data-processed");
      diagram.classList.add("mermaid");
      pre.classList.add("mermaid-wrap");
    }
    void mermaid.run({ nodes: diagrams }).catch(() => {
      setRenderError("This diagram could not be rendered. Its source is shown below.");
    });
  }, [dark, html]);

  return (
    <main
      style={
        {
          "--text": textColor,
          "--muted": mutedColor,
          "--surface": surfaceColor,
          "--border": borderColor,
        } as React.CSSProperties
      }
    >
      {renderError ? <div className="render-error">{renderError}</div> : null}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify sanitizes marked output before it reaches this isolated DOM component. */}
      <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} ref={root} />
      <style>{`
        :root { color-scheme: ${dark ? "dark" : "light"}; }
        * { box-sizing: border-box; }
        html, body, #root { margin: 0; min-height: 0; background: transparent; }
        body {
          overflow: hidden;
          color: var(--text);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          -webkit-font-smoothing: antialiased;
        }
        main { width: 100%; overflow: hidden; }
        .markdown { font-size: 16px; line-height: 1.42; letter-spacing: -0.15px; }
        .markdown > :first-child { margin-top: 0; }
        .markdown > :last-child { margin-bottom: 0; }
        p, ul, ol, blockquote, pre, table, .katex-display { margin: 0 0 10px; }
        h1, h2, h3, h4, h5, h6 { margin: 12px 0 7px; line-height: 1.18; }
        h1 { font-size: 23px; } h2 { font-size: 20px; } h3 { font-size: 18px; }
        ul, ol { padding-left: 24px; }
        li + li { margin-top: 3px; }
        blockquote { margin-left: 0; padding-left: 12px; border-left: 3px solid var(--muted); color: var(--muted); }
        a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
        code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.84em; }
        :not(pre) > code { padding: 2px 4px; border-radius: 5px; background: var(--surface); }
        pre { max-width: 100%; overflow-x: auto; padding: 11px 12px; border-radius: 11px; background: var(--surface); }
        pre code { white-space: pre; }
        table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
        th, td {
          padding: 8px 7px;
          border: 0;
          border-bottom: 1px solid var(--border);
          text-align: left;
          vertical-align: top;
          overflow-wrap: anywhere;
        }
        th { color: var(--text); font-weight: 650; }
        td { color: var(--muted); }
        hr { height: 1px; margin: 12px 0; border: 0; background: var(--border); }
        .katex { display: inline-block; max-width: 100%; }
        .katex-display { display: block; max-width: 100%; overflow-x: auto; overflow-y: hidden; padding: 4px 0; text-align: center; }
        math { font-size: 1.04em; }
        .mermaid-wrap { overflow-x: auto; padding: 10px; border: 1px solid var(--border); background: var(--surface); }
        .mermaid { display: flex; justify-content: center; min-width: max-content; }
        .mermaid svg { max-width: none !important; height: auto; }
        .render-error { margin-bottom: 8px; color: #C0443B; font-size: 12px; font-weight: 600; }
      `}</style>
    </main>
  );
}
