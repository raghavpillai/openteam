import type { ComponentProps } from "react";
import {
  type Components,
  type ControlsConfig,
  defaultUrlTransform,
  type MermaidOptions,
  type ThemeInput,
  type UrlTransform,
} from "streamdown";
import { OPENTEAM_DEEP_LINK_EVENT } from "../../../lib/app-deep-links";

export { OPENTEAM_DEEP_LINK_EVENT } from "../../../lib/app-deep-links";

const SANITIZED_MESSAGE_LINK_PREFIX = "streamdown:sand-msg:";
const SANITIZED_OPENTEAM_LINK_PREFIX = "streamdown:openteam:";

export const streamdownControls: ControlsConfig = {
  code: { copy: true, download: false },
  image: false,
  mermaid: { copy: true, download: true, fullscreen: true, panZoom: true },
  table: false,
};

const botLightTheme = {
  name: "bot-light",
  type: "light",
  colors: {
    "editor.background": "#fcfcfc",
    "editor.foreground": "#333333",
  },
  settings: [
    { settings: { background: "#fcfcfc", foreground: "#333333" } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#686868" },
    },
    {
      scope: [
        "keyword",
        "storage.type.function",
        "storage.type.string",
        "storage.modifier",
        "constant.language",
      ],
      settings: { foreground: "#ae1d42" },
    },
    {
      scope: [
        "entity.name.function",
        "entity.name.function.call",
        "entity.name.command",
        "support.function",
      ],
      settings: { foreground: "#d67551" },
    },
    {
      scope: [
        "support.type",
        "entity.name.type",
        "constant.numeric",
        "constant.other.option",
        "constant.character.format.placeholder",
        "support.type.property-name",
      ],
      settings: { foreground: "#306493" },
    },
    {
      scope: ["string", "string.quoted", "string.interpolated"],
      settings: { foreground: "#a194d4" },
    },
    {
      scope: ["string.json", "support.type.property-name.json"],
      settings: { foreground: "#333333" },
    },
  ],
} satisfies ThemeInput;

export const botShikiTheme: [ThemeInput, ThemeInput] = [botLightTheme, "github-dark"];

export const botMermaidOptions: MermaidOptions = {
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

const normalizeLatexDelimiters = (markdown: string) =>
  markdown
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment
        .replace(
          /\\\[([\s\S]*?)\\\]/g,
          (_match, expression: string) => `$$\n${expression.trim()}\n$$`
        )
        .replace(/\\\(([^\n]*?)\\\)/g, (_match, expression: string) => `$${expression}$`);
    })
    .join("");

export const prepareMessageMarkdown = (markdown: string) =>
  normalizeLatexDelimiters(markdown)
    .replace(/(\]\(\s*)sand-msg:/gi, `$1${SANITIZED_MESSAGE_LINK_PREFIX}`)
    .replace(/(\]\(\s*)openteam:/gi, `$1${SANITIZED_OPENTEAM_LINK_PREFIX}`);

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

export const messageComponents: Components = { a: MessageLink };
