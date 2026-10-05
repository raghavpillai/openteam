import { normalizeMessageMath } from "./math-markdown";

export const SANITIZED_MESSAGE_LINK_PREFIX = "streamdown:sand-msg:";
export const SANITIZED_OPENTEAM_LINK_PREFIX = "streamdown:openteam:";

/** Source normalization is independent of browser rendering and authentication. */
export const prepareMessageMarkdown = (markdown: string) =>
  normalizeMessageMath(markdown)
    .replace(/(\]\(\s*)sand-msg:/gi, `$1${SANITIZED_MESSAGE_LINK_PREFIX}`)
    .replace(/(\]\(\s*)openteam:/gi, `$1${SANITIZED_OPENTEAM_LINK_PREFIX}`);
