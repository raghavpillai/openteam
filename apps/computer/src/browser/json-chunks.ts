// Browser snapshots are plain JSON data from CDP (structured IndexedDB values
// are already packed). Keep large strings bounded too: splitting only at object
// boundaries would still duplicate an entire base64 cache response.
const STRING_SLICE = 16 * 1024;
const OUTPUT_CHUNK = 64 * 1024;

function* quoted(value: string): Generator<string> {
  yield '"';
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + STRING_SLICE, value.length);
    // JSON.stringify must see both halves of a surrogate pair together.
    const last = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    const part = value.slice(offset, end);
    // Cache bodies are usually base64. Reuse those slices directly instead of
    // allocating an escaped copy and then removing its quotes.
    yield /["\\\u0000-\u001f\ud800-\udfff]/.test(part)
      ? JSON.stringify(part).slice(1, -1)
      : part;
    offset = end;
  }
  yield '"';
}

function* tokens(value: unknown, ancestors: Set<object>): Generator<string> {
  if (typeof value === "string") {
    yield* quoted(value);
  } else if (value === null || typeof value !== "object") {
    // Object properties with undefined values are skipped below; array holes
    // and nonfinite numbers retain JSON.stringify's null representation.
    yield JSON.stringify(value) ?? "null";
  } else {
    if (ancestors.has(value)) throw new TypeError("Circular browser state");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        yield "[";
        for (let index = 0; index < value.length; index++) {
          if (index) yield ",";
          yield* tokens(value[index], ancestors);
        }
        yield "]";
      } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
          throw new TypeError("Browser state must contain plain JSON objects");
        yield "{";
        let first = true;
        for (const key of Object.keys(value)) {
          const item = (value as Record<string, unknown>)[key];
          if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
          if (!first) yield ",";
          first = false;
          yield* quoted(key);
          yield ":";
          yield* tokens(item, ancestors);
        }
        yield "}";
      }
    } finally {
      ancestors.delete(value);
    }
  }
}

/**
 * Same JSON bytes as JSON.stringify for plain browser data, with bounded string
 * chunks. The caller must retain/replace snapshots, not mutate them while an
 * async consumer is writing. Do not collect this iterator into an array.
 */
export function* browserJsonChunks(value: unknown): Generator<string> {
  let chunk = "";
  for (const token of tokens(value, new Set())) {
    if (chunk.length + token.length > OUTPUT_CHUNK && chunk) {
      yield chunk;
      chunk = "";
    }
    chunk += token;
  }
  if (chunk) yield chunk;
}

/** Preserve the existing UTF-16 length limit without allocating the full JSON. */
export function browserJsonExceeds(value: unknown, limit: number): boolean {
  let length = 0;
  for (const chunk of browserJsonChunks(value)) {
    length += chunk.length;
    if (length > limit) return true;
  }
  return false;
}
