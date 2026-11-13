import { ChevronDown, ChevronRight } from "lucide-react";
import {
  type ReactNode,
  type CSSProperties,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TokensResult } from "shiki/core";
import { useVirtualWindow } from "../../../hooks/use-virtual-window";
import { highlightAsync } from "../../ai-elements/message-response/code-worker-client";
import { botShikiTheme } from "../../ai-elements/message-response/code-theme";
import { AttachmentStageDismiss, AttachmentStageTools } from "../attachment-stage";

const languages: Record<string, string> = {
  py: "python",
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  sh: "bash",
  bash: "bash",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  html: "html",
  htm: "html",
  xml: "xml",
  sql: "sql",
  go: "go",
  rs: "rust",
  c: "c",
  h: "c",
  cpp: "cpp",
  java: "java",
  swift: "swift",
  rb: "ruby",
  toml: "toml",
};

export function TextFilePreview({ value, fileName }: { value: string; fileName: string }) {
  const lines = useMemo(() => value.split("\n"), [value]);
  const language = languages[fileName.split(".").at(-1)?.toLowerCase() ?? ""];
  const [highlight, setHighlight] = useState<{
    value: string;
    tokens: TokensResult["tokens"];
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const estimate = useCallback(() => 21, []);
  const key = useCallback((index: number) => String(index), []);
  const { totalSize, virtualItems } = useVirtualWindow({
    count: lines.length,
    estimateSize: estimate,
    getKey: key,
    scrollRef,
    overscan: 300,
    initialViewportSize: 800,
    maxItems: 110,
  });
  useEffect(() => {
    if (!language || value.length > 200_000) return;
    let active = true;
    void highlightAsync(value, language, botShikiTheme)
      .then((result) => {
        if (active) setHighlight({ value, tokens: result.tokens });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [language, value]);
  const tokens = highlight?.value === value ? highlight.tokens : null;
  return (
    <div className="preview-code-scroll bot-scrollbar" ref={scrollRef}>
      <pre
        aria-label={fileName}
        className="preview-code"
        style={{
          height: totalSize,
          minWidth: `${
            Math.min(
              20_000,
              lines.reduce((longest, line) => Math.max(longest, line.length), 50)
            ) *
              7.8 +
            96
          }px`,
        }}
      >
        <code>
          {virtualItems.map((item) => (
            <span
              className="preview-code-line"
              key={item.key}
              style={{ position: "absolute", top: item.start, left: 0, right: 0 }}
            >
              <span aria-hidden="true" className="preview-line-number">
                {item.index + 1}
              </span>
              <span>
                {tokens?.[item.index]?.map((token, index) => (
                  <span
                    className="preview-code-token"
                    key={index}
                    style={
                      {
                        "--preview-token-light": token.color ?? token.htmlStyle?.color,
                        "--preview-token-dark": token.htmlStyle?.["--shiki-dark"] ?? token.color,
                      } as CSSProperties
                    }
                  >
                    {token.content}
                  </span>
                )) ??
                  lines[item.index] ??
                  "\n"}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export function JsonFilePreview({ value, fileName }: { value: string; fileName: string }) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(value) as unknown };
    } catch {
      return { ok: false as const };
    }
  }, [value]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (!parsed.ok) return <TextFilePreview value={value} fileName={fileName} />;
  let budget = 800;
  const node = (data: unknown, label: string | null, path: string, depth: number): ReactNode => {
    if (--budget < 0 || depth > 40) return null;
    const branch = data !== null && typeof data === "object";
    const entries = branch ? Object.entries(data) : [];
    const open = expanded[path] ?? depth < 2;
    const summary = branch
      ? Array.isArray(data)
        ? `[${entries.length} ${entries.length === 1 ? "item" : "items"}]`
        : `{${entries.length} ${entries.length === 1 ? "key" : "keys"}}`
      : null;
    return (
      <div className="preview-json-node" key={path}>
        <div className="preview-json-row">
          {branch ? (
            <button
              aria-expanded={open}
              aria-label={`${open ? "Collapse" : "Expand"} ${label ?? "root"}`}
              className="preview-json-caret"
              onClick={() => setExpanded((current) => ({ ...current, [path]: !open }))}
              type="button"
            >
              {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            </button>
          ) : (
            <span className="preview-json-spacer" />
          )}
          {label !== null && (
            <>
              <span className="preview-json-key">{label}</span>
              <span className="preview-json-punctuation">: </span>
            </>
          )}
          {branch ? (
            <span className="preview-meta">{summary}</span>
          ) : (
            <span className={`preview-json-${data === null ? "null" : typeof data}`}>
              {typeof data === "string" ? JSON.stringify(data) : String(data)}
            </span>
          )}
        </div>
        {branch && open && (
          <div className="preview-json-children">
            {entries
              .slice(0, 200)
              .map(([key, value]) =>
                node(value, key, `${path}/${encodeURIComponent(key)}`, depth + 1)
              )}
            {entries.length > 200 && (
              <div className="preview-meta">
                {entries.length - 200} more entries. Download to view all.
              </div>
            )}
          </div>
        )}
      </div>
    );
  };
  return (
    <div className="preview-json bot-scrollbar">
      {node(parsed.value, null, "root", 0)}
      {budget < 0 && <p className="preview-meta">Expand fewer branches to view more entries.</p>}
    </div>
  );
}

export function HtmlFilePreview({ value }: { value: string }) {
  const close = useContext(AttachmentStageDismiss);
  const frame = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<"preview" | "source">("preview");
  const [nonce] = useState(() => crypto.randomUUID());
  useEffect(() => {
    const escape = (event: MessageEvent) => {
      if (
        event.source === frame.current?.contentWindow &&
        event.data?.type === "openteam-preview-escape" &&
        event.data?.nonce === nonce
      )
        close();
    };
    window.addEventListener("message", escape);
    return () => window.removeEventListener("message", escape);
  }, [close, nonce]);
  const source = useMemo(() => {
    const parsed = new DOMParser().parseFromString(value, "text/html");
    for (const element of parsed.querySelectorAll(
      "iframe,object,embed,base,meta[http-equiv],link,script[src]"
    ))
      element.remove();
    const policy = parsed.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content =
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none';";
    const keyboard = parsed.createElement("script");
    keyboard.textContent = `addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); parent.postMessage({ type: 'openteam-preview-escape', nonce: ${JSON.stringify(nonce)} }, '*'); } }, true);`;
    parsed.head.prepend(keyboard);
    parsed.head.prepend(policy);
    return `<!doctype html>${parsed.documentElement.outerHTML}`;
  }, [value, nonce]);
  return (
    <>
      <AttachmentStageTools>
        <div aria-label="HTML view" className="preview-segmented" role="tablist">
          <button
            aria-selected={view === "preview"}
            onClick={() => setView("preview")}
            role="tab"
            type="button"
          >
            Preview
          </button>
          <button
            aria-selected={view === "source"}
            onClick={() => setView("source")}
            role="tab"
            type="button"
          >
            Source
          </button>
        </div>
      </AttachmentStageTools>
      {view === "source" ? (
        <TextFilePreview value={value} fileName="Source.html" />
      ) : (
        <iframe
          className="preview-html"
          ref={frame}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts"
          srcDoc={source}
          title="HTML file preview"
        />
      )}
    </>
  );
}
