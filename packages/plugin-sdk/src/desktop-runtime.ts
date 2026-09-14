const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Desktop adapters are explicitly supported by the host, never arbitrary package commands. */
export function desktopMcpProvider(value: unknown): "1password" | null {
  const config = objectValue(value);
  if (config.runtime === undefined || config.runtime === "computer") return null;
  if (config.runtime !== "desktop") throw new Error("Unknown MCP runtime");
  if (config.provider !== "1password" || config.command !== "1password-mcp")
    throw new Error("Unsupported desktop MCP provider");
  if ((Array.isArray(config.args) ? config.args.length > 0 : config.args != null) || config.cwd ||
      Object.keys(objectValue(config.env)).some((key) => key !== "OPENTEAM_PLUGIN_ACCOUNT_ID"))
    throw new Error("Desktop MCP providers do not accept custom commands, arguments, directories, or environment variables");
  return "1password";
}
