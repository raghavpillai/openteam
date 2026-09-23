import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

// Bound retained text across all sessions. Repeated observations of the same
// tool result should not tokenize it again while a summary is pending.
const counts = new Map<string, number>();
const MAX_CACHED_CHARS = 1_000_000;
let cachedChars = 0;

/** Text estimate, not a provider receipt. Keep the old floor for other models;
 * o200k catches dense hashes, code and Unicode that chars/4 undercounts badly. */
export function estimateBotTextTokens(text: string): number {
  if (!text) return 0;
  const cached = counts.get(text);
  if (cached !== undefined) return cached;
  // Special-looking strings in documents are ordinary text, not control tokens.
  const tokens = Math.max(
    Math.ceil(text.length / 4),
    countTokens(text, { disallowedSpecial: new Set() })
  );
  if (text.length <= MAX_CACHED_CHARS) {
    while (counts.size >= 512 || cachedChars + text.length > MAX_CACHED_CHARS) {
      const oldest = counts.keys().next().value!;
      counts.delete(oldest);
      cachedChars -= oldest.length;
    }
    counts.set(text, tokens);
    cachedChars += text.length;
  }
  return tokens;
}
