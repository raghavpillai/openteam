import bplist from "bplist-parser";
import { basename } from "node:path";

export interface MessageRun {
  text: string;
  mention?: string;
  part?: number;
}
export interface MessageBody {
  text: string;
  runs: MessageRun[];
  /** True only when the archive could not be decoded and text was scanned out of its bytes. */
  fallback: boolean;
}

const stripPlaceholders = (text: string) => text.replaceAll("￼", "");

/*
 * A data-only typedstream (NSArchiver "streamtyped") reader: it walks the archive's typed values
 * and rebuilds only the plain Foundation values attributed bodies use. No Objective-C class is
 * instantiated and unknown classes are skipped structurally.
 */
const TAG_INTEGER_2 = -127;
const TAG_INTEGER_4 = -126;
const TAG_FLOATING_POINT = -125;
const TAG_NEW = -124;
const TAG_NIL = -123;
const TAG_END_OF_OBJECT = -122;
const FIRST_TAG = -128;
const LAST_TAG = -111;
const REFERENCE_BASE = LAST_TAG + 1;

interface ArchivedClass {
  name: string;
  version: number;
  superclass?: ArchivedClass;
}
class ArchivedString {
  constructor(readonly string: string) {}
}
class ArchivedAttributedString extends ArchivedString {
  constructor(string: string, readonly runs: Array<{ range: [number, number]; attributes: Record<string, unknown> }>) {
    super(string);
  }
}
class ArchivedValue {
  constructor(readonly value: unknown) {}
}
class ArchivedDictionary {
  constructor(readonly contents: Map<unknown, unknown>) {}
}
class ArchivedData {
  constructor(readonly data: Buffer) {}
}
class ArchivedObject {
  constructor(readonly className: string) {}
}

/** Splits a type-encoding string such as `iI`, `[12c]` or `{_NSRange=QQ}` into its encodings. */
function splitEncodings(encoding: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < encoding.length; ) {
    const open = encoding[i]!;
    const close = open === "[" ? "]" : open === "{" ? "}" : open === "(" ? ")" : "";
    if (!close) {
      parts.push(open);
      i++;
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < encoding.length; j++) {
      if (encoding[j] === open) depth++;
      else if (encoding[j] === close && --depth === 0) break;
    }
    if (depth !== 0) throw new Error("Unbalanced type encoding");
    parts.push(encoding.slice(i, j + 1));
    i = j + 1;
  }
  return parts;
}
function structFields(encoding: string): string[] {
  const inner = encoding.slice(1, -1);
  const equals = inner.indexOf("=");
  return equals < 0 ? [] : splitEncodings(inner.slice(equals + 1));
}

class TypedStream {
  private pos = 0;
  private littleEndian = false;
  private readonly strings: Buffer[] = [];
  private readonly objects: unknown[] = [];
  constructor(private readonly data: Buffer) {
    const version = this.integer(false);
    const signatureLength = this.integer(false);
    if (version !== 4 || signatureLength !== 11) throw new Error("Unsupported typedstream header");
    const signature = this.exact(11).toString("latin1");
    if (signature === "streamtyped") this.littleEndian = true;
    else if (signature !== "typedstream") throw new Error("Unsupported typedstream signature");
    this.integer(false);
  }
  get done() {
    return this.pos >= this.data.length;
  }
  private exact(length: number) {
    if (length < 0 || this.pos + length > this.data.length) throw new Error("Truncated typedstream");
    const bytes = this.data.subarray(this.pos, this.pos + length);
    this.pos += length;
    return bytes;
  }
  private head(head?: number) {
    return head ?? this.exact(1).readInt8(0);
  }
  private integer(signed: boolean, head?: number): number {
    head = this.head(head);
    if (head < FIRST_TAG || head > LAST_TAG) return signed ? head : head & 255;
    if (head === TAG_INTEGER_2) {
      const b = this.exact(2);
      return signed ? (this.littleEndian ? b.readInt16LE() : b.readInt16BE()) : this.littleEndian ? b.readUInt16LE() : b.readUInt16BE();
    }
    if (head === TAG_INTEGER_4) {
      const b = this.exact(4);
      return signed ? (this.littleEndian ? b.readInt32LE() : b.readInt32BE()) : this.littleEndian ? b.readUInt32LE() : b.readUInt32BE();
    }
    throw new Error("Unexpected typedstream tag");
  }
  private real(size: 4 | 8) {
    const head = this.head();
    if (head !== TAG_FLOATING_POINT) return this.integer(true, head);
    const b = this.exact(size);
    return size === 4 ? (this.littleEndian ? b.readFloatLE() : b.readFloatBE()) : this.littleEndian ? b.readDoubleLE() : b.readDoubleBE();
  }
  private unshared(head?: number): Buffer | undefined {
    head = this.head(head);
    if (head === TAG_NIL) return undefined;
    return this.exact(this.integer(false, head));
  }
  private shared(head?: number): Buffer | undefined {
    head = this.head(head);
    if (head === TAG_NIL) return undefined;
    if (head === TAG_NEW) {
      const value = this.unshared();
      if (value === undefined) throw new Error("Nil shared string");
      this.strings.push(value);
      return value;
    }
    return this.strings[this.integer(true, head) - REFERENCE_BASE];
  }
  private reference(head: number) {
    const index = this.integer(true, head) - REFERENCE_BASE;
    if (index < 0 || index >= this.objects.length) throw new Error("Dangling typedstream reference");
    return this.objects[index];
  }
  /** One group of typed values; `expected` enforces the encodings a class's archive format fixes. */
  group(head?: number, expected?: string): unknown[] {
    const encoding = this.shared(head)?.toString("latin1");
    if (encoding === undefined) throw new Error("Nil type encoding");
    if (expected !== undefined && encoding !== expected) throw new Error("Unexpected type encoding");
    return splitEncodings(encoding).map((part) => this.value(part));
  }
  private value(encoding: string): unknown {
    const type = encoding[0];
    switch (type) {
      case "C":
      case "B":
        return this.exact(1).readUInt8(0);
      case "c":
        return this.exact(1).readInt8(0);
      case "S":
      case "I":
      case "L":
      case "Q":
        return this.integer(false);
      case "s":
      case "i":
      case "l":
      case "q":
        return this.integer(true);
      case "f":
        return this.real(4);
      case "d":
        return this.real(8);
      case "*": {
        const head = this.head();
        if (head === TAG_NIL) return undefined;
        if (head !== TAG_NEW) return this.reference(head);
        const value = this.shared()?.toString("latin1");
        if (value === undefined) throw new Error("Nil C string");
        this.objects.push(value);
        return value;
      }
      case "%":
      case ":":
        return this.shared()?.toString("latin1");
      case "+":
        return this.unshared();
      case "#":
        return this.archivedClass();
      case "@":
        return this.object();
      case "!":
        return undefined;
      case "[": {
        const match = /^\[(\d+)(.+)\]$/s.exec(encoding);
        if (!match) throw new Error("Invalid array encoding");
        const length = Number(match[1]);
        if (match[2] === "c" || match[2] === "C") return this.exact(length);
        return Array.from({ length }, () => this.value(match[2]!));
      }
      case "{":
        return structFields(encoding).map((field) => this.value(field));
      default:
        throw new Error("Unsupported type encoding");
    }
  }
  private archivedClass(head?: number): ArchivedClass | undefined {
    head = this.head(head);
    const chain: Array<{ name: string; version: number }> = [];
    while (head === TAG_NEW) {
      const name = this.shared()?.toString("latin1");
      if (name === undefined) throw new Error("Nil class name");
      chain.push({ name, version: this.integer(true) });
      head = this.head();
    }
    let superclass = head === TAG_NIL ? undefined : (this.reference(head) as ArchivedClass);
    const built: ArchivedClass[] = [];
    for (const link of chain.reverse()) built.unshift((superclass = { ...link, superclass }));
    this.objects.push(...built);
    return superclass;
  }
  private object(): unknown {
    const head = this.head();
    if (head === TAG_NIL) return undefined;
    if (head !== TAG_NEW) return this.reference(head);
    const index = this.objects.push(undefined) - 1;
    const archived = this.archivedClass();
    if (!archived) throw new Error("Object without a class");
    const value = this.initialize(archived);
    this.objects[index] = value;
    return value;
  }
  private end() {
    if (this.head() !== TAG_END_OF_OBJECT) throw new Error("Expected end of object");
  }
  private only(expected: string) {
    return this.group(undefined, expected)[0];
  }
  private initialize({ name, version }: ArchivedClass): unknown {
    const requireVersion = (wanted: number) => {
      if (version !== wanted) throw new Error("Unsupported class version");
    };
    switch (name) {
      case "NSString":
      case "NSMutableString": {
        requireVersion(1);
        const bytes = this.only("+");
        if (!Buffer.isBuffer(bytes)) throw new Error("String without bytes");
        this.end();
        return new ArchivedString(bytes.toString("utf8"));
      }
      case "NSAttributedString":
      case "NSMutableAttributedString": {
        requireVersion(0);
        const string = (this.group()[0] as ArchivedString | undefined)?.string;
        if (typeof string !== "string") throw new Error("Attributed string without a string");
        const runs: ArchivedAttributedString["runs"] = [];
        const shared = new Map<unknown, Record<string, unknown>>();
        for (let start = 0; start < string.length; ) {
          const [reference, length] = this.group();
          if (typeof length !== "number" || length <= 0) throw new Error("Invalid attribute run");
          if (!shared.has(reference)) shared.set(reference, this.attributes());
          runs.push({ range: [start, length], attributes: shared.get(reference)! });
          start += length;
        }
        this.end();
        return new ArchivedAttributedString(string, runs);
      }
      case "NSDictionary":
      case "NSMutableDictionary": {
        requireVersion(0);
        const count = this.only("i") as number;
        if (count < 0) throw new Error("Negative dictionary count");
        const contents = new Map<unknown, unknown>();
        for (let i = 0; i < count; i++) {
          const key = this.only("@");
          contents.set(key, this.only("@"));
        }
        this.end();
        return new ArchivedDictionary(contents);
      }
      case "NSValue":
      case "NSNumber": {
        requireVersion(0);
        const encoding = this.only("*");
        if (typeof encoding !== "string") throw new Error("Value without an encoding");
        const value = this.only(encoding);
        this.end();
        return new ArchivedValue(value);
      }
      case "NSData":
      case "NSMutableData": {
        requireVersion(0);
        const length = this.only("i") as number;
        if (length < 0) throw new Error("Negative data length");
        const bytes = this.only(`[${length}c]`) as Buffer;
        this.end();
        return new ArchivedData(Buffer.from(bytes));
      }
      case "NSArray":
      case "NSMutableArray":
      case "NSSet":
      case "NSMutableSet": {
        requireVersion(0);
        const count = this.only(name.endsWith("Set") ? "I" : "i") as number;
        if (count < 0) throw new Error("Negative collection count");
        const elements = Array.from({ length: count }, () => this.only("@"));
        this.end();
        return new ArchivedValue(elements);
      }
      case "NSDate": {
        requireVersion(0);
        this.only("d");
        this.end();
        return new ArchivedObject(name);
      }
      case "NSObject":
        requireVersion(0);
        this.end();
        return new ArchivedObject(name);
      default: {
        for (let head = this.head(); head !== TAG_END_OF_OBJECT; head = this.head()) this.group(head);
        return new ArchivedObject(name);
      }
    }
  }
  private attributes(): Record<string, unknown> {
    const dictionary = this.group()[0];
    if (!(dictionary instanceof ArchivedDictionary)) throw new Error("Attributes are not a dictionary");
    const attributes: Record<string, unknown> = {};
    for (const [key, value] of dictionary.contents) {
      const name = (key as ArchivedString | undefined)?.string;
      if (typeof name !== "string") continue;
      attributes[name] =
        value instanceof ArchivedString ? value.string : value instanceof ArchivedValue ? value.value : value instanceof ArchivedData ? value : undefined;
    }
    return attributes;
  }
}

function decodeTypedstream(bytes: Buffer): MessageBody {
  const stream = new TypedStream(bytes);
  const groups: unknown[][] = [];
  while (!stream.done) groups.push(stream.group());
  if (groups.length !== 1 || groups[0]!.length !== 1) throw new Error("Archive must hold exactly one root value");
  const root = groups[0]![0];
  const string = root instanceof ArchivedString ? root.string : "";
  const runs = root instanceof ArchivedAttributedString ? root.runs : [];
  return {
    text: stripPlaceholders(string),
    runs: runs.map(({ range: [start, length], attributes }) => {
      const mention = attributes.__kIMMentionConfirmedMention;
      const part = attributes.__kIMMessagePartAttributeName;
      return {
        text: stripPlaceholders(string.slice(start, start + length)),
        ...(typeof mention === "string" ? { mention } : {}),
        ...(typeof part === "number" ? { part } : {}),
      };
    }),
    fallback: false,
  };
}

const indexOfPair = (bytes: Buffer, first: number, second: number, from: number) => {
  for (let i = from; i < bytes.length - 1; i++) if (bytes[i] === first && bytes[i + 1] === second) return i;
  return -1;
};
/** Last resort for archives the reader rejects: the first string's bytes up to the next object marker. */
function scanArchivedText(bytes: Buffer): MessageBody {
  const marker = indexOfPair(bytes, 1, 43, 0);
  let text = "";
  if (marker >= 0) {
    const end = indexOfPair(bytes, 134, 132, marker + 2);
    const raw = new TextDecoder().decode(bytes.subarray(marker + 2, end < 0 ? bytes.length : end));
    text = stripPlaceholders(raw.charCodeAt(0) < 32 ? raw.slice(1) : raw);
  }
  return { text, runs: text ? [{ text }] : [], fallback: true };
}
/** Keyed archives (bplist) carry the plain string under NS.string; only their text is recovered. */
function decodeKeyedArchive(bytes: Buffer): MessageBody | null {
  const archive = bplist.parseBuffer(bytes)[0] as any;
  const objects = archive?.$objects;
  if (!Array.isArray(objects)) return null;
  const resolve = (value: any) => (value && typeof value === "object" && typeof value.UID === "number" ? objects[value.UID] : value);
  let root = resolve(archive.$top?.root);
  for (let depth = 0; depth < 8; depth++) {
    if (typeof root === "string") {
      const text = stripPlaceholders(root);
      return { text, runs: text ? [{ text }] : [], fallback: true };
    }
    if (!root || typeof root !== "object") break;
    root = resolve(root["NS.string"] ?? root["NSString"] ?? root["NSAttributedString"]);
  }
  return null;
}

/**
 * A message's body as data only: the archived attributed body when present (its text and runs,
 * object-replacement placeholders removed), else the plain `text` column.
 */
export function messageBody(text: unknown, hex: unknown): MessageBody {
  if (typeof hex === "string" && hex.length > 0 && hex.length <= 8_000_000 && /^(?:[\da-f]{2})+$/i.test(hex)) {
    const bytes = Buffer.from(hex, "hex");
    if (bytes.subarray(0, 8).toString("latin1") === "bplist00") {
      try {
        const keyed = decodeKeyedArchive(bytes);
        if (keyed) return keyed;
      } catch {
        /* Fall through to the byte scan. */
      }
      return scanArchivedText(bytes);
    }
    try {
      return decodeTypedstream(bytes);
    } catch {
      return scanArchivedText(bytes);
    }
  }
  const plain = typeof text === "string" ? text : "";
  return { text: plain, runs: plain ? [{ text: plain }] : [], fallback: false };
}

const APPLE_EPOCH_MS = 978_307_200_000;
/** Unix milliseconds for a Messages date column: nanoseconds since 2001 (or seconds on old stores); 0/null is absent. */
export function messageMs(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  let raw: bigint;
  try {
    raw = BigInt(typeof value === "number" ? Math.trunc(value) : String(value));
  } catch {
    return undefined;
  }
  if (raw === 0n) return undefined;
  return APPLE_EPOCH_MS + Number(raw > 1_000_000_000_000n ? raw / 1_000_000n : raw * 1000n);
}
/** The wire's ISO-8601 millisecond timestamp for a Messages date column, or undefined when absent. */
export function messageDate(value: unknown): string | undefined {
  const ms = messageMs(value);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}
/** The same unix-millisecond key in SQL, so ordering and cursors agree with `messageMs` exactly. */
export const messageMsSql = (column: string) =>
  `COALESCE(${APPLE_EPOCH_MS}+CASE WHEN ${column}>1000000000000 THEN ${column}/1000000 WHEN ${column}<>0 THEN ${column}*1000 END,0)`;
/** Parses an ISO-8601 timestamp that carries an offset, as the tools require. */
export function isoMs(value: unknown, name: string): number {
  const ms = typeof value === "string" && /(?:Z|[+-]\d\d:?\d\d)$/i.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`${name} must be an ISO-8601 timestamp with an offset`);
  return ms;
}

/** Wire attachment metadata; `filename` is the stored path's last component. */
export function wireAttachment(row: Record<string, any>) {
  return {
    id: Number(row.id),
    guid: row.guid,
    ...(row.filename ? { filename: basename(String(row.filename)) } : {}),
    ...(row.transferName ? { transferName: row.transferName } : {}),
    ...(row.mime ? { mime: row.mime } : {}),
    ...(row.uti ? { uti: row.uti } : {}),
    ...(row.totalBytes != null ? { totalBytes: Number(row.totalBytes) } : {}),
  };
}
