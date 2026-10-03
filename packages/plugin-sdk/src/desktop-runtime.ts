const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Packaged MCP connections run on the bot computer. */
export function assertComputerMcpRuntime(value: unknown): void {
  const config = objectValue(value);
  if (config.runtime === undefined || config.runtime === "computer") return;
  throw new Error("Unsupported MCP runtime");
}
