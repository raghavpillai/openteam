import bplist from "bplist-parser";
export interface MessageBody {
  text: string;
  fallback: boolean;
}
/** Extract text as data only: no Objective-C class instantiation from archives. */
export function decodeMessageBody(text: unknown, hex: unknown): MessageBody | null {
  if (typeof text === "string" && text.length) return { text, fallback: false };
  if (typeof hex !== "string" || !hex || hex.length > 4_000_000 || !/^(?:[\da-f]{2})+$/i.test(hex))
    return typeof text === "string" ? { text, fallback: false } : null;
  const data = Buffer.from(hex, "hex");
  try {
    if (data.subarray(0, 8).toString() === "bplist00") {
      const archive = bplist.parseBuffer(data)[0] as any;
      const objects = archive?.$objects;
      if (!Array.isArray(objects)) return null;
      const resolve = (value: any) =>
        value && typeof value === "object" && typeof value.UID === "number"
          ? objects[value.UID]
          : value;
      let root = resolve(archive.$top?.root);
      for (let depth = 0; depth < 8; depth++) {
        if (typeof root === "string") return { text: root, fallback: true };
        if (!root || typeof root !== "object") break;
        root = resolve(root["NS.string"] ?? root["NSString"] ?? root["NSAttributedString"]);
      }
      return null;
    }
    if (!data.subarray(0, 16).includes(Buffer.from("streamtyped"))) return null;
    const marker = data.indexOf(Buffer.from([1, 43]));
    if (marker < 0) return null;
    let offset = marker + 2;
    let length = data[offset++]!;
    if (length === 0x81) {
      length = data.readUInt16LE(offset);
      offset += 2;
    } else if (length === 0x82) {
      length = data.readUInt32LE(offset);
      offset += 4;
    } else if (length >= 0x80) return null;
    if (length > 2_000_000 || offset + length > data.length) return null;
    // Formatting, range attributes, stickers and app payloads are not plain text.
    // Keep the recovered body and identify that reduction explicitly.
    return { text: data.subarray(offset, offset + length).toString("utf8"), fallback: true };
  } catch {
    return null;
  }
}
export function messageDate(value: string | number): string {
  const nanos = BigInt(value);
  const milliseconds = nanos / 1_000_000n;
  const base = new Date(Date.UTC(2001, 0, 1) + Number(milliseconds)).toISOString();
  const fraction = ((nanos % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n;
  return base.replace(/\.\d{3}Z$/, `.${fraction.toString().padStart(9, "0")}Z`);
}
export function messageTimestamp(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Use an ISO-8601 timestamp with an offset");
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? "";
  const milliseconds = BigInt(Date.parse(value) - Date.UTC(2001, 0, 1));
  return milliseconds * 1_000_000n + BigInt(fraction.padEnd(9, "0").slice(3, 9) || "0");
}
export function normalizeMessageRow(row: Record<string, any>) {
  const { bodyHex, date_edited, date_retracted, ...metadata } = row;
  if (metadata.handle == null) delete metadata.handle;
  const body = decodeMessageBody(row.text, bodyHex);
  const reaction = Number(row.associated_message_type ?? 0);
  return {
    ...metadata,
    date: messageDate(row.date),
    body,
    chatGuids: JSON.parse(row.chatGuids ?? "[]"),
    attachments: JSON.parse(row.attachments ?? "[]"),
    kind:
      reaction >= 2000 && reaction < 4000
        ? "reaction"
        : Number(date_retracted) > 0
          ? "unsent"
          : row.is_system_message || row.item_type
            ? "group-event"
            : "message",
    ...(reaction >= 2000 && reaction < 4000
      ? {
          reaction: {
            type: reaction % 1000,
            removed: reaction >= 3000,
            targetGuid: row.associated_message_guid,
          },
        }
      : {}),
    ...(Number(date_edited) > 0 ? { editedAt: messageDate(date_edited) } : {}),
    ...(Number(date_retracted) > 0 ? { retractedAt: messageDate(date_retracted) } : {}),
    ...(body ? { text: body.text } : { notice: "No decodable body is available for this item" }),
  };
}
