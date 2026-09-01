export type AdvancedMessageCapabilities = {
  cjk: boolean;
  code: boolean;
  math: boolean;
  mermaid: boolean;
};

const MATH_PATTERN = /\$\$|\\[[(]|(?:^|[^\\$])\$(?![$\s])(?:\\.|[^$\n])+\$/;
const ADVANCED_CANDIDATE_PATTERN = /```|~~~|\$\$|\\[[(]|(?:^|[^\\$])\$(?![$\s])(?:\\.|[^$\n])+\$/;
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/u;
const FENCE_TOKEN_PATTERN = /```|~~~/;
const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})(?:[\t ]*([^\s`~]+))?.*$/;

/**
 * Determines the independently loadable Streamdown capabilities used by a
 * message. A Mermaid-only fence deliberately does not initialize Shiki.
 */
export const detectAdvancedMessageCapabilities = (content: string): AdvancedMessageCapabilities => {
  let activeFence: { character: "`" | "~"; length: number } | undefined;
  let code = false;
  let mermaid = false;
  let sawStructuredFence = false;

  for (const line of content.split(/\r?\n/)) {
    const match = FENCE_LINE_PATTERN.exec(line);
    if (!match?.[1]) continue;

    const marker = match[1];
    const character = marker[0] as "`" | "~";
    if (activeFence) {
      if (character === activeFence.character && marker.length >= activeFence.length && !match[2]) {
        activeFence = undefined;
      }
      continue;
    }

    sawStructuredFence = true;
    activeFence = { character, length: marker.length };
    const language = match[2]?.toLocaleLowerCase();
    if (language === "mermaid") mermaid = true;
    else code = true;
  }

  // Preserve the previous permissive handling of malformed/inline fences.
  if (FENCE_TOKEN_PATTERN.test(content) && !sawStructuredFence) code = true;

  const prose = content
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .filter((_, index) => index % 2 === 0)
    .join("");

  return {
    cjk: CJK_PATTERN.test(prose),
    code,
    math: MATH_PATTERN.test(prose),
    mermaid,
  };
};

export const messageNeedsAdvancedRenderer = (content: string) => {
  return advancedMessageCapabilitiesFor(content) !== null;
};

export const advancedMessageCapabilitiesFor = (
  content: string
): AdvancedMessageCapabilities | null => {
  if (!ADVANCED_CANDIDATE_PATTERN.test(content)) return null;
  const capabilities = detectAdvancedMessageCapabilities(content);
  return capabilities.code || capabilities.math || capabilities.mermaid ? capabilities : null;
};
