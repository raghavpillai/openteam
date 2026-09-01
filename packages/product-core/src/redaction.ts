const REDACTED = "[REDACTED]";

const replacements: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  [/\b(sk-(?:proj-)?[A-Za-z0-9_-]{16,})\b/g, REDACTED],
  [/\b(gh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED],
  [/\b(xox(?:p|b|a|r|s)-[A-Za-z0-9-]{10,})\b/g, REDACTED],
  [
    /\b((?:OPENBOT_[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY)|PASSWORD|PASSWD|API_KEY|AUTH_TOKEN)\s*[=:]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    `$1${REDACTED}`,
  ],
  [
    /(["'](?:password|passwd|secret|token|api[_-]?key|authorization)["']\s*:\s*["'])(.*?)(["'])/gi,
    `$1${REDACTED}$3`,
  ],
  [
    /(--(?:password|token|secret|api-key)(?:=|\s+))("[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)/gi,
    `$1${REDACTED}`,
  ],
  [/(https?:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, `$1${REDACTED}$3`],
];

/** Redacts common credentials before text reaches logs, doctor output, or diagnostics. */
export const redactSensitiveText = (value: string): string => {
  let redacted = value;
  for (const [pattern, replacement] of replacements) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
};

export const safeErrorMessage = (error: unknown): string =>
  redactSensitiveText(error instanceof Error ? error.message : String(error));

/** User-facing error copy with a useful fallback and credential redaction. */
export const clientErrorMessage = (error: unknown, fallback: string): string => {
  const message =
    error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  return redactSensitiveText(message || fallback);
};
