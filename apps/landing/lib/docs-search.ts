export type SearchEntry = {
  title: string;
  pageTitle: string;
  group: string;
  href: string;
  text: string;
};

export type DocsSearchIndex = {
  entries: SearchEntry[];
  // Flat [entry ID, weight] pairs, prepared at build time.
  terms: Record<string, number[]>;
  suggestions: number[];
};

export type SearchResult = SearchEntry & { snippet: string; matches: string[] };

export function normalizeSearch(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function searchWords(value: string) {
  return normalizeSearch(value).match(/[a-z0-9]+/g) ?? [];
}

const stopWords = new Set(["a", "an", "and", "are", "can", "do", "does", "for", "how", "i", "in", "is", "it", "of", "on", "the", "to", "what", "with"]);

// One insertion, deletion, replacement, or adjacent transposition.
function isCloseWord(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (i === a.length) return b.length - i <= 1;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1)
      || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function snippet(text: string, matches: string[]) {
  const lower = normalizeSearch(text);
  const positions = matches.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const position = positions.length ? Math.min(...positions) : 0;
  let start = Math.max(0, position - 55);
  if (start) {
    const space = text.indexOf(" ", start);
    if (space >= 0 && space < position) start = space + 1;
  }
  let end = Math.min(text.length, start + 175);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start) end = space;
  }
  return `${start ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** The only runtime work is looking up prebuilt postings and ranking a small result set. */
export function createDocsSearch(index: DocsSearchIndex) {
  const vocabulary = Object.keys(index.terms);
  const titles = index.entries.map((entry) => normalizeSearch(entry.title));
  const pageTitles = index.entries.map((entry) => normalizeSearch(entry.pageTitle));
  return (query: string, limit = 8): SearchResult[] => {
    if (limit <= 0) return [];
    const words = [...new Set(searchWords(query.slice(0, 200)))];
    const significant = words.filter((word) => !stopWords.has(word));
    const tokens = (significant.length ? significant : words).slice(0, 12);
    if (!tokens.length) {
      return index.suggestions.slice(0, limit).map((id) => ({ ...index.entries[id], snippet: snippet(index.entries[id].text, []), matches: [] }));
    }

    let scores: Map<number, number> | undefined;
    const matches = new Map<number, Set<string>>();
    for (const token of tokens) {
      const tokenScores = new Map<number, number>();
      const candidates: [string, number][] = [];
      for (const word of vocabulary) {
        if (word === token) candidates.push([word, 1]);
        else if (token.length >= 2 && word.startsWith(token)) candidates.push([word, .75]);
        else if (token.length >= 4 && isCloseWord(token, word)) candidates.push([word, .4]);
      }
      for (const [word, quality] of candidates) {
        const postings = index.terms[word];
        for (let i = 0; i < postings.length; i += 2) {
          const id = postings[i];
          tokenScores.set(id, Math.max(tokenScores.get(id) ?? 0, postings[i + 1] * quality));
          if (!matches.has(id)) matches.set(id, new Set());
          matches.get(id)!.add(word);
        }
      }
      if (!scores) scores = tokenScores;
      else {
        for (const [id, score] of scores) {
          const next = tokenScores.get(id);
          if (next === undefined) scores.delete(id);
          else scores.set(id, score + next);
        }
      }
      if (!scores.size) return [];
    }

    const phrase = normalizeSearch(query.trim());
    const ranked = [...scores!].map(([id, score]) => ({
      id,
      score: score + (titles[id] === phrase ? 60 : titles[id].includes(phrase) ? 20 : 0)
        + (pageTitles[id].includes(phrase) ? 8 : 0),
    })).sort((a, b) => b.score - a.score || a.id - b.id);
    const perPage = new Map<string, number>();
    const results: SearchResult[] = [];
    for (const { id } of ranked) {
      const entry = index.entries[id];
      const page = entry.href.split("#")[0];
      const count = perPage.get(page) ?? 0;
      if (count >= 2) continue;
      perPage.set(page, count + 1);
      const terms = [...(matches.get(id) ?? [])];
      results.push({ ...entry, snippet: snippet(entry.text, terms), matches: terms });
      if (results.length >= limit) break;
    }
    return results;
  };
}

export type DocsSearch = ReturnType<typeof createDocsSearch>;
