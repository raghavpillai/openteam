/**
 * Escape price markers before remark-math sees them. A price cannot close at
 * the start of another price ($4 ... $1,944) or another expression ($4 ... $x$).
 * Keep complete math spans intact, including numeric and padded expressions.
 * Call this only on prose, outside code spans and fences.
 */
export function escapeCurrencyDollars(prose: string): string {
  let result = "";
  let index = 0;
  while (index < prose.length) {
    const character = prose[index]!;
    if (character === "\\") {
      // Explicit LaTeX regions may themselves contain currency (e.g. \\text).
      const delimiter = prose[index + 1];
      const close = delimiter === "(" ? "\\)" : delimiter === "[" ? "\\]" : null;
      const end = close ? prose.indexOf(close, index + 2) : -1;
      const next = end < 0 ? index + 2 : end + 2;
      result += prose.slice(index, next);
      index = next;
      continue;
    }
    if (character !== "$") {
      result += character;
      index++;
      continue;
    }

    const run = /^\$+/.exec(prose.slice(index))![0];
    if (run.length > 1) {
      const end = prose.indexOf(run, index + run.length);
      const next = end < 0 ? prose.length : end + run.length;
      result += prose.slice(index, next);
      index = next;
      continue;
    }

    let end = index + 1;
    while (end < prose.length && prose[end] !== "$") {
      end += prose[end] === "\\" ? 2 : 1;
    }
    const hasClose = prose[end] === "$" && prose[end + 1] !== "$";
    const startsWithAmount = /^[+-]?(?:\d|\.\d)/.test(prose.slice(index + 1));
    // Opening punctuation/Markdown can sit between a price and the next
    // expression. A sign directly after real math ($2+2$+3) stays literal.
    const openingBoundary = /[\s*_~[(–—-]/.test(prose[end - 1] ?? "");
    const closesAtNextValue =
      /^\d/.test(prose.slice(end + 1)) ||
      (openingBoundary && /^[+-]?(?:\d|\.\d)|^[\p{L}\\]/u.test(prose.slice(end + 1)));
    if (startsWithAmount && (!hasClose || closesAtNextValue)) {
      result += "\\$";
      index++;
    } else if (hasClose) {
      result += prose.slice(index, end + 1);
      index = end + 1;
    } else {
      result += "$";
      index++;
    }
  }
  return result;
}

// Keep code (including an unfinished streamed fence) and link destinations
// byte-for-byte intact. Backtick spans may use multiple backticks or newlines.
export function normalizeMessageMath(markdown: string): string {
  const literal = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)|(`+)|https?:\/\/[^\s<>]+/gm;
  const normalize = (segment: string) =>
    escapeCurrencyDollars(segment)
      .replace(
        /\\\[([\s\S]*?)\\\]/g,
        (_match, expression: string) => `$$\n${expression.trim()}\n$$`
      )
      .replace(/\\\(([^\n]*?)\\\)/g, (_match, expression: string) => `$${expression}$`);
  let result = "";
  let index = 0;
  for (let match = literal.exec(markdown); match; match = literal.exec(markdown)) {
    let end = literal.lastIndex;
    const fence = match[1];
    const ticks = match[2];
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*(?:\\n|$)`, "gm");
      close.lastIndex = end;
      const closing = close.exec(markdown);
      end = closing ? close.lastIndex : markdown.length;
    } else if (ticks) {
      const close = new RegExp(`(?<!\x60)${ticks}(?!\x60)`, "g");
      close.lastIndex = end;
      const closing = close.exec(markdown);
      if (closing) end = close.lastIndex;
    }
    result += normalize(markdown.slice(index, match.index)) + markdown.slice(match.index, end);
    index = end;
    literal.lastIndex = end;
  }
  return result + normalize(markdown.slice(index));
}
