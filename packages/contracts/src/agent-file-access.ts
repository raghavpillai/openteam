/** Input is a canonical path relative to the agent-data root, using `/`. */
export const protectedAgentDataPath = (relativePath: string): "private" | "database" | null => {
  const parts = relativePath.split("/");
  if (parts[0] === ".." || relativePath.startsWith("/")) return null;
  if ((parts[0] ?? "").startsWith(".") ||
      ["settings.json", "transcription.json", "connector-secrets"].includes(parts[0] ?? "")) return "private";
  // Only live stores directly under an agent folder are runtime databases.
  // Deliverables in nested folders may legitimately use the same filenames.
  if (parts.length === 3 && parts[0] === "agents" &&
      /^(?:store|conversation-blobs)\.db(?:-(?:shm|wal|journal))?$/.test(parts[2] ?? "")) return "database";
  return null;
};
