export const LIVE_ROOT_ID = "sand-live-conversation-root-v1__";

export const safeId = (value: string): string => {
  if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new Error("agent id is not a safe filesystem segment");
  }
  return value;
};

export const hexJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("hex");

export const parseHexJson = (value: string): Record<string, unknown> => {
  const parsed = JSON.parse(Buffer.from(value, "hex").toString("utf8")) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};
