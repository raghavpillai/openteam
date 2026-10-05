import "./markdown.css";
import type { ComponentProps } from "react";
import {
  type Components,
  type ControlsConfig,
  defaultUrlTransform,
  type MermaidOptions,
  type UrlTransform,
} from "streamdown";
import { useAuthenticatedResource } from "../../../hooks/use-authenticated-resource";
import { OPENTEAM_DEEP_LINK_EVENT } from "../../../lib/app-deep-links";
import { SANITIZED_MESSAGE_LINK_PREFIX, SANITIZED_OPENTEAM_LINK_PREFIX } from "./markdown-source";
export { prepareMessageMarkdown } from "./markdown-source";

export { OPENTEAM_DEEP_LINK_EVENT } from "../../../lib/app-deep-links";

export const streamdownControls: ControlsConfig = {
  code: { copy: true, download: false },
  image: false,
  mermaid: { copy: true, download: true, fullscreen: true, panZoom: true },
  table: false,
};

export { botShikiTheme } from "./code-theme";

export const botMermaidOptions: MermaidOptions = {
  errorComponent: ({ chart, error, retry }) => (
    <div data-chat-diagram-error className="rounded-lg bg-muted p-3 text-sm">
      <p>{error}</p>
      <pre className="overflow-x-auto whitespace-pre-wrap">{chart}</pre>
      <button onClick={retry} type="button">Retry diagram</button>
    </div>
  ),
  config: {
    theme: "base",
    themeVariables: {
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
      fontSize: "14px",
      lineColor: "#333333",
      primaryBorderColor: "#9770d9",
      primaryColor: "#edecff",
      primaryTextColor: "#333333",
    },
  },
};

export const messageUrlTransform: UrlTransform = (url, key, node) =>
  url.startsWith(SANITIZED_MESSAGE_LINK_PREFIX) || url.startsWith(SANITIZED_OPENTEAM_LINK_PREFIX)
    ? url
    : defaultUrlTransform(url, key, node);

const jumpToMessage = (address: string) => {
  const target = Array.from(
    document.querySelectorAll<HTMLElement>("[data-message-address], [data-message-id]")
  ).find(
    (element) => element.dataset.messageAddress === address || element.dataset.messageId === address
  );
  if (!target) return;

  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.remove("message-jump-target");
  window.requestAnimationFrame(() => target.classList.add("message-jump-target"));
  window.setTimeout(() => target.classList.remove("message-jump-target"), 1_600);
};

type MarkdownAnchorProps = ComponentProps<"a"> & { node?: unknown };

function MessageLink({ children, className, href, node: _node, ...props }: MarkdownAnchorProps) {
  const encodedAddress = href?.startsWith(SANITIZED_MESSAGE_LINK_PREFIX)
    ? href.slice(SANITIZED_MESSAGE_LINK_PREFIX.length)
    : null;
  let address = encodedAddress;
  if (encodedAddress) {
    try {
      address = decodeURIComponent(encodedAddress);
    } catch {
      address = encodedAddress;
    }
  }

  if (address) {
    return (
      <button
        aria-label={`Jump to referenced message ${address}`}
        className="message-jump-chip"
        data-message-jump={address}
        onClick={() => jumpToMessage(address)}
        title="Jump to earlier message"
        type="button"
      >
        <span aria-hidden="true">↪</span>
        {children}
      </button>
    );
  }

  const openTeamPath = href?.startsWith(SANITIZED_OPENTEAM_LINK_PREFIX)
    ? href.slice(SANITIZED_OPENTEAM_LINK_PREFIX.length)
    : null;
  if (openTeamPath) {
    const url = `openteam:${openTeamPath}`;
    return (
      <button
        aria-label={`Open ${String(children)}`}
        className="message-jump-chip"
        onClick={() =>
          window.dispatchEvent(new CustomEvent(OPENTEAM_DEEP_LINK_EVENT, { detail: { url } }))
        }
        type="button"
      >
        {children}
      </button>
    );
  }

  return (
    <a
      className={className}
      data-streamdown="link"
      href={href}
      rel="noreferrer"
      target="_blank"
      {...props}
    >
      {children}
    </a>
  );
}

function MessageImage({
  src,
  alt,
  node: _node,
  ...props
}: ComponentProps<"img"> & { node?: unknown }) {
  const source = useAuthenticatedResource(typeof src === "string" ? src : null);
  const width = Number(props.width);
  const height = Number(props.height);
  const knownSize = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
  const frameWidth = knownSize ? Math.min(width, 320, (width / height) * 300) : 320;
  return (
    <span className="relative inline-block max-w-full overflow-hidden align-middle rounded-lg bg-muted"
      style={{ width: frameWidth, aspectRatio: knownSize ? `${width} / ${height}` : "16 / 9" }}>
      <img
        {...props}
        alt={alt ?? ""}
        src={source ?? undefined}
        loading="lazy"
        data-streamdown="image"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }}
      />
    </span>
  );
}

export const messageComponents: Components = { a: MessageLink, img: MessageImage };
