import type { ExternalDraft } from "./external-draft";

export interface DraftRevision {
  baselineMessageId: string;
  changedFields: string[];
  body: { text: string; added: boolean }[];
}
type Token = { text: string; word: boolean };
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("und", { granularity: "word" }) : null;
const tokenize = (text: string): Token[] => segmenter
  ? Array.from(segmenter.segment(text), (part) => ({ text: part.segment, word: part.isWordLike === true }))
  : text.split(/(\s+)/).filter(Boolean).map((text) => ({ text, word: /\S/.test(text) }));
const words = (tokens: Token[]) => tokens.filter((token) => token.word).length;
const addresses = (values?: string[]) => [...new Set(values?.map((value) => value.toLowerCase()) ?? [])].sort().join(",");
const destination = (draft: ExternalDraft) => draft.platform === "email" ? addresses(draft.to) : draft.channelId;
const sameRoute = (a: ExternalDraft, b: ExternalDraft) =>
  a.platform === b.platform && a.providerIdentifier === b.providerIdentifier &&
  a.from?.toLowerCase() === b.from?.toLowerCase() && a.replyToMessageId === b.replyToMessageId &&
  a.forwardMessageId === b.forwardMessageId && a.channelId === b.channelId && a.threadTs === b.threadTs;

/** Bounded weighted LCS; equal scores prefer nearby occurrences of repeated words. */
function anchors(before: string[], after: string[], budget = 1_000_000): [number, number][] | null {
  const width = after.length + 1;
  if ((before.length + 1) * width > budget) return null;
  const scores = new Uint32Array((before.length + 1) * width);
  const at = (i: number, j: number) => scores[i * width + j] ?? 0;
  const match = (i: number, j: number) => at(i + 1, j + 1) + 1_000_001 - Math.abs(i - j);
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      scores[i * width + j] = Math.max(at(i + 1, j), at(i, j + 1), before[i] === after[j] ? match(i, j) : 0);
  const result: [number, number][] = [];
  let i = 0, j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j] && at(i, j) === match(i, j)) { result.push([i++, j++]); }
    else if (at(i + 1, j) >= at(i, j + 1)) i++;
    else j++;
  }
  return result;
}

function align(before: Token[], after: Token[]) {
  let head = 0, tail = 0;
  while (head < before.length && head < after.length && before[head]!.text === after[head]!.text) head++;
  while (head + tail < before.length && head + tail < after.length && before.at(-1 - tail)!.text === after.at(-1 - tail)!.text) tail++;
  const old = before.slice(head, before.length - tail), next = after.slice(head, after.length - tail);
  const oldWords = old.flatMap((token, i) => token.word ? [i] : []);
  const newWords = next.flatMap((token, i) => token.word ? [i] : []);
  const matched = anchors(oldWords.map((i) => old[i]!.text), newWords.map((i) => next[i]!.text));
  if (!matched) return null;
  return { head: after.slice(0, head), old, next, tail: after.slice(after.length - tail),
    anchors: matched.map(([i, j]) => [oldWords[i]!, newWords[j]!] as [number, number]),
    retained: words(after.slice(0, head)) + matched.length + words(after.slice(after.length - tail)) };
}

function segments(alignment: NonNullable<ReturnType<typeof align>>) {
  const result: DraftRevision["body"] = [];
  const append = (tokens: Token[], added: boolean) => {
    const text = tokens.map((token) => token.text).join("");
    if (!text) return;
    const previous = result.at(-1);
    if (previous?.added === added) previous.text += text;
    else result.push({ text, added });
  };
  append(alignment.head, false);
  let i = 0, j = 0, budget = 1_000_000;
  for (const [oldEnd, newEnd] of [...alignment.anchors, [alignment.old.length, alignment.next.length] as [number, number]]) {
    const old = alignment.old.slice(i, oldEnd), next = alignment.next.slice(j, newEnd);
    const fine = anchors(old.map((token) => token.text), next.map((token) => token.text), budget);
    if (fine) budget -= (old.length + 1) * (next.length + 1);
    let offset = 0;
    for (const [, newIndex] of fine ?? []) {
      append(next.slice(offset, newIndex), true);
      append([next[newIndex]!], false);
      offset = newIndex + 1;
    }
    append(next.slice(offset), true);
    if (newEnd < alignment.next.length) append([alignment.next[newEnd]!], false);
    i = oldEnd + 1; j = newEnd + 1;
  }
  append(alignment.tail, false);
  // Whitespace alone is never highlighted.
  return result.map((part) => ({ ...part, added: part.added && /\S/.test(part.text) }));
}

/** Match only nearby previous turns, suppress ambiguous baselines and large rewrites. */
export function draftRevision(current: ExternalDraft, candidates: { id: string; draft: ExternalDraft; turn: number }[]): DraftRevision | undefined {
  const tokens = tokenize(current.body), count = words(tokens);
  if (!count) return;
  const matches = candidates.filter((candidate) => candidate.turn >= 1 && candidate.turn <= 3 && sameRoute(current, candidate.draft))
    .flatMap((candidate) => {
      const alignment = align(tokenize(candidate.draft.body), tokens);
      return alignment && alignment.retained / count >= 0.5 ? [{ ...candidate, alignment }] : [];
    });
  const best = Math.max(...matches.map((match) => match.alignment.retained));
  const close = matches.filter((match) => (best - match.alignment.retained) / count < 0.2);
  const turn = Math.min(...close.map((match) => match.turn));
  let eligible = close.filter((match) => match.turn === turn);
  if (eligible.length > 1) eligible = eligible.filter((match) => destination(match.draft) === destination(current));
  if (eligible.length !== 1) return;
  const baseline = eligible[0]!, body = segments(baseline.alignment);
  const added = body.filter((part) => part.added);
  if (added.length > 3 || added.reduce((sum, part) => sum + words(tokenize(part.text)), 0) > Math.max(20, count * 0.25)) return;
  const changedFields = (current.platform === "email" ? ["to", "cc", "subject"] : ["target"]).filter((key) => {
    if (key === "to" || key === "cc") return addresses(current[key]) !== addresses(baseline.draft[key]);
    return current[key as "subject" | "target"] !== baseline.draft[key as "subject" | "target"];
  });
  return added.length || changedFields.length ? { baselineMessageId: baseline.id, changedFields, body } : undefined;
}
