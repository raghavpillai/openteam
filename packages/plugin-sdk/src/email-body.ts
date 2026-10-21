// Plain-text email bodies as models write them. A port of the reference's
// email-body unwrap (10-20 build); keep its constants and edge cases in step.
const FENCE = /^\s*(?:```|~~~)/;
const SIGNATURE_DELIMITER = /^--\s?$/;
const QUOTE = /^\s*>/;
const TABLE = /\t|\|.*\|/;
const URL_ONLY = /^\s*<?https?:\/\/\S+>?\s*$/;
const INDENTED = /^(?: {2}|\t)/;
const LIST_MARKER = /^[ \t]*(?:[-*•]|(\d+)[.)])[ \t]+/;
const STARTS_LOWERCASE = /^\p{Ll}/u;
const KEY_VALUE = /^\p{Lu}[\p{L}\p{N} &/'-]{0,24}:\s/u;
const SENTENCE_END = /[.!?:;]$/;
const MAX_WRAPPED_LINE = 100;
const MIN_WRAPPED_LINE = 50;
const MAX_NAME_WORDS = 3;
const NEAR_WIDTH = 20;
const FIT_TOLERANCE = 5;
const HTML_MARKUP = /<\/(?:p|div|li|ul|ol|strong|b|em|i|span|a|h[1-6])\s*>|<br\s*\/?>/i;

type Kind = "blank" | "verbatim" | "listItem" | "continuation" | "prose";
type Line = { kind: Kind; text: string };

/** The first HTML tag in a plain-text body, if any: such a body would reach the recipient as literal tags. */
export const emailBodyHtmlTag = (body: string): string | undefined => HTML_MARKUP.exec(body)?.[0];

function kindOf(text: string, previous?: Kind): Kind {
  if (text.trim().length === 0) return "blank";
  if (QUOTE.test(text) || TABLE.test(text) || URL_ONLY.test(text)) return "verbatim";
  const inListItem = previous === "listItem" || previous === "continuation";
  if (INDENTED.test(text) && !inListItem) return "verbatim";
  if (LIST_MARKER.test(text)) return "listItem";
  return inListItem && (INDENTED.test(text) || STARTS_LOWERCASE.test(text)) ? "continuation" : "prose";
}
function classifyLines(texts: string[]): Line[] {
  const lines: Line[] = [];
  let fenced = false;
  let signed = false;
  for (const text of texts) {
    const fence = FENCE.test(text);
    signed ||= !fenced && SIGNATURE_DELIMITER.test(text);
    const kind = fence || fenced || signed ? "verbatim" : kindOf(text, lines.at(-1)?.kind);
    if (fence) fenced = !fenced;
    lines.push({ kind, text });
  }
  return lines;
}
const lengthOf = (text: string) => [...text.trimEnd()].length;
const words = (text: string) => text.trim().split(/\s+/);
const endsSentence = (text: string) => SENTENCE_END.test(text.trimEnd());
function isNameLine(lines: Line[], index: number) {
  const { text } = lines[index]!;
  const lastInParagraph = index + 1 === lines.length || lines[index + 1]!.kind === "blank";
  return lastInParagraph && words(text).length <= MAX_NAME_WORDS && !endsSentence(text);
}
function isCandidateBreak(lines: Line[], index: number) {
  const line = lines[index]!;
  const next = lines[index + 1]!;
  return (
    (next.kind === "continuation" || (line.kind === "prose" && next.kind === "prose")) &&
    lengthOf(line.text) <= MAX_WRAPPED_LINE &&
    !KEY_VALUE.test(next.text.trimStart()) &&
    !isNameLine(lines, index + 1)
  );
}
function breaksMidSentence(lines: Line[], index: number) {
  const { text } = lines[index]!;
  return (
    lengthOf(text) >= MIN_WRAPPED_LINE &&
    !endsSentence(text) &&
    STARTS_LOWERCASE.test(lines[index + 1]!.text.trimStart())
  );
}
function paragraphBreaks(lines: Line[]) {
  const paragraphs: number[][] = [];
  let breaks: number[] = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (lines[index]!.kind !== "blank" && lines[index + 1]!.kind !== "blank") breaks.push(index);
    else if (breaks.length > 0) {
      paragraphs.push(breaks);
      breaks = [];
    }
  }
  if (breaks.length > 0) paragraphs.push(breaks);
  return paragraphs;
}
function wrappedAtWidth(lines: Line[], index: number, width: number) {
  const length = lengthOf(lines[index]!.text);
  const nextWord = lengthOf(words(lines[index + 1]!.text)[0]!);
  return length >= width - NEAR_WIDTH && length + 1 + nextWord > width - FIT_TOLERANCE;
}
function rejoin(lines: Line[], joins: Set<number>) {
  let body = lines[0]!.text;
  for (let index = 1; index < lines.length; index += 1) {
    const { text } = lines[index]!;
    body = joins.has(index - 1) ? `${body.trimEnd()} ${text.trimStart()}` : `${body}\n${text}`;
  }
  return body;
}

/**
 * Rejoins lines a model hard-wrapped mid-sentence at roughly one width, so mail doesn't
 * arrive with a break in every sentence. Quotes, tables, code, list structure, key: value
 * lines, short name lines and everything below a "-- " signature delimiter stay as written.
 * Not idempotent across paragraphs of different widths: apply it once, to what the model wrote.
 */
export function unwrapHardWrappedEmailBody(body: string): string {
  const lines = classifyLines(body.replace(/\r\n?/g, "\n").split("\n"));
  const softBreaks = paragraphBreaks(lines)
    .map((breaks) => breaks.filter((index) => isCandidateBreak(lines, index)))
    .filter((breaks) => breaks.some((index) => breaksMidSentence(lines, index)))
    .flat();
  if (softBreaks.length === 0) return body;
  const width = Math.max(...softBreaks.map((index) => lengthOf(lines[index]!.text)));
  const joins = new Set(softBreaks.filter((index) => wrappedAtWidth(lines, index, width)));
  return joins.size === 0 ? body : rejoin(lines, joins);
}
