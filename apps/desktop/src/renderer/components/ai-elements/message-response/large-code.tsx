import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { CodeBlockContainer, CodeBlockCopyButton, CodeBlockHeader } from "streamdown";
import type { TokensResult } from "shiki/core";
import { code as highlighter } from "./code";
import { botShikiTheme } from "./code-theme";
import "./large-code.css";

const LARGE_CODE_CHARACTERS = 16_384;
let nextHighlight = 0;

// Keep Streamdown's inline code, ordinary fences and Mermaid renderer intact.
export function MessagePre({ children }: { children?: ReactNode }) {
  if (!isValidElement(children)) return children;
  const child = children as ReactElement<{ children?: ReactNode; className?: string }>;
  const source = child.props.children;
  const language = child.props.className?.match(/language-([^\s]+)/)?.[1] ?? "";
  if (typeof source === "string" && source.length >= LARGE_CODE_CHARACTERS && language !== "mermaid" && typeof CSS !== "undefined" && CSS.highlights) {
    return <LargeCode source={source} language={language} />;
  }
  return cloneElement(child, { "data-block": "true" } as object);
}

type Token = TokensResult["tokens"][number][number];
const fontStyle = (token: Token): CSSProperties | undefined => {
  const styles = token.htmlStyle ?? {};
  const entries = Object.entries(styles).filter(([key]) => /font-|text-decoration/.test(key));
  if (!entries.length) return undefined;
  return Object.fromEntries(entries.map(([key, value]) => [key.startsWith("--") ? key : key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
};

function LargeCode({ source, language }: { source: string; language: string }) {
  const display = useMemo(() => source.replace(/\n+$/, ""), [source]);
  const [highlighted, setHighlighted] = useState<{ source: string; language: string; result: TokensResult }>();
  const result = highlighted?.source === display && highlighted.language === language ? highlighted.result : undefined;
  const body = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true;
    const finish = (result: TokensResult) => { if (active) setHighlighted({ source: display, language, result }); };
    const immediate = highlighter.highlight({ code: display, language, themes: botShikiTheme }, (value) => finish(value as TokensResult));
    if (immediate) finish(immediate as TokensResult);
    return () => { active = false; };
  }, [display, language]);

  // Font metrics require real spans. Color-only tokens share the same text node,
  // retaining native selection, accessibility and find-in-page across all lines.
  const content = useMemo(() => {
    if (!result) return display;
    const pieces: ReactNode[] = [];
    let offset = 0;
    for (const line of result.tokens) for (const token of line) {
      const style = fontStyle(token);
      if (!style || !token.content) continue;
      if (offset < token.offset) pieces.push(display.slice(offset, token.offset));
      pieces.push(<span className="bot-code-font" key={token.offset} style={style}>{token.content}</span>);
      offset = token.offset + token.content.length;
    }
    if (offset < display.length) pieces.push(display.slice(offset));
    return pieces;
  }, [display, result]);

  useEffect(() => {
    const scroller = body.current;
    const element = text.current;
    if (!scroller || !element || !result) return;
    const id = `bot-code-${++nextHighlight}`;
    const sheet = document.createElement("style");
    document.head.append(sheet);
    const nodes: Array<{ node: Text; start: number; end: number }> = [];
    const starts = new WeakMap<Node, number>();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let offset = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      starts.set(node, offset);
      nodes.push({ node, start: offset, end: offset + node.length });
      offset += node.length;
    }
    const point = (offset: number) => {
      let low = 0, high = nodes.length - 1;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (nodes[middle]!.end < offset) low = middle + 1;
        else high = middle;
      }
      const entry = nodes[low]!;
      return { node: entry.node, offset: offset - entry.start };
    };
    const names: string[] = [];
    let frame = 0;
    let painted = "";
    const clear = () => { for (const name of names) CSS.highlights.delete(name); names.length = 0; };
    const paint = () => {
      frame = 0;
      if (!nodes.length) return;
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
      const first = Math.max(0, Math.floor(scroller.scrollTop / lineHeight) - 20);
      const last = Math.min(result.tokens.length, Math.ceil((scroller.scrollTop + scroller.clientHeight) / lineHeight) + 20);
      // Width matters for long single lines even when the visible line range
      // and scroll offset stay unchanged (for example, closing the inspector).
      const key = `${first}:${last}:${Math.floor(scroller.scrollLeft)}:${scroller.clientWidth}:${scroller.clientHeight}`;
      if (painted === key) return;
      painted = key;
      clear();
      const groups = new Map<string, { highlight: Highlight; light: string; dark: string; lightBg: string; darkBg: string }>();
      const bounds = scroller.getBoundingClientRect();
      const textTop = element.getBoundingClientRect().top;
      for (let line = first; line < last; line++) {
        const tokens = result.tokens[line]!;
        let left = -Infinity, right = Infinity;
        // Minified files can put thousands of tokens on a single line. Native
        // caret hit-testing also handles tabs, wide glyphs and font metrics.
        if (tokens.length > 1_000) {
          const y = textTop + (line + 0.5) * lineHeight;
          if (y < bounds.top || y > bounds.bottom) continue;
          const start = document.caretPositionFromPoint(bounds.left + 14, y);
          const end = document.caretPositionFromPoint(bounds.right - 48, y);
          const startOffset = start && starts.get(start.offsetNode);
          const endOffset = end && starts.get(end.offsetNode);
          const fallback = tokens[0]!.offset + Math.floor(scroller.scrollLeft / (lineHeight * 0.44));
          left = startOffset != null && start ? startOffset + start.offset - 200 : fallback - 200;
          right = endOffset != null && end ? endOffset + end.offset + 200 : fallback + 2_000;
        }
        for (const token of tokens) {
        if (token.offset + token.content.length < left || token.offset > right) continue;
        if (!token.content || token.offset + token.content.length > display.length) continue;
        const style = token.htmlStyle ?? {};
        const light = style.color ?? token.color ?? "inherit";
        const dark = style["--shiki-dark"] ?? light;
        const lightBg = style["background-color"] ?? token.bgColor ?? "transparent";
        const darkBg = style["--shiki-dark-bg"] ?? lightBg;
        const key = JSON.stringify([light, dark, lightBg, darkBg]);
        let group = groups.get(key);
        if (!group) { group = { highlight: new Highlight(), light, dark, lightBg, darkBg }; groups.set(key, group); }
        const range = new Range();
        const start = point(token.offset), end = point(token.offset + token.content.length);
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        group.highlight.add(range);
        }
      }
      // Only theme registrations supply CSS, never the source text.
      const rules: string[] = [];
      for (const group of groups.values()) {
        const name = `${id}-${names.length}`;
        names.push(name);
        CSS.highlights.set(name, group.highlight);
        rules.push(`::highlight(${name}){color:${group.light};background-color:${group.lightBg}}:root[data-theme="dark"] ::highlight(${name}){color:${group.dark};background-color:${group.darkBg}}`);
      }
      sheet.textContent = rules.join("\n");
      element.dataset.highlighted = "true";
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
    scroller.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(scroller);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      scroller.removeEventListener("scroll", schedule);
      clear();
      sheet.remove();
      delete element.dataset.highlighted;
    };
  }, [display, result]);

  return <CodeBlockContainer language={language} dir="ltr">
    <CodeBlockHeader language={language} />
    <div className="pointer-events-none"><div className="pointer-events-auto flex" data-streamdown="code-block-actions"><CodeBlockCopyButton code={source} /></div></div>
    <div ref={body} data-streamdown="code-block-body" data-language={language}>
      <pre><code ref={text} data-large-code="true">{content}</code></pre>
    </div>
  </CodeBlockContainer>;
}
