import { createHash } from "node:crypto";
import {
  assembleUpstreamPlugin,
  parsePluginDefinition,
  PACKAGE_MAX_BYTES,
  type PluginDefinition,
} from "@openteam/plugin-sdk";

/** Download original provider assets into this installation, never into the shipped registry. */
export async function resolveUpstreamPlugin(
  input: PluginDefinition,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  installed?: PluginDefinition
): Promise<PluginDefinition> {
  const definition = parsePluginDefinition(input);
  const source = definition.upstream;
  if (!source || source.delivery !== "install") return definition;
  const files: Record<string, string> = {};
  const binaryFiles: Record<string, string> = {};
  let total = 0;
  const entries = Object.entries(source.files);
  // Bounded concurrency and sizes keep a malformed upstream from consuming server resources.
  for (let start = 0; start < entries.length; start += 4) {
    await Promise.all(
      entries.slice(start, start + 4).map(async ([path, expected]) => {
        const target = `upstream/${path}`;
        const reusable = installed?.upstream?.files[path] === expected ? installed : undefined;
        const text = definition.files?.[target] ?? reusable?.files?.[target];
        const binary = definition.binaryFiles?.[target] ?? reusable?.binaryFiles?.[target];
        let bytes: Uint8Array;
        if (text !== undefined) bytes = new TextEncoder().encode(text);
        else if (binary !== undefined) bytes = Buffer.from(binary, "base64");
        else {
          const location = [source.directory, path]
            .filter(Boolean)
            .join("/")
            .split("/")
            .map(encodeURIComponent)
            .join("/");
          const url = `https://raw.githubusercontent.com/${source.repository}/${source.revision}/${location}`;
          const response = await request(url, {
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok)
            throw new Error(
              `Cannot download ${definition.name} source (${response.status}): ${path}`
            );
          if (Number(response.headers.get("content-length")) > PACKAGE_MAX_BYTES)
            throw new Error("Upstream plugin exceeds its size limit");
          const chunks: Uint8Array[] = [];
          let size = 0;
          const reader = response.body?.getReader();
          if (!reader) throw new Error(`Empty upstream response: ${path}`);
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > PACKAGE_MAX_BYTES)
                throw new Error("Upstream plugin exceeds its size limit");
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
          bytes = Buffer.concat(chunks);
        }
        total += bytes.length;
        if (total > PACKAGE_MAX_BYTES) throw new Error("Upstream plugin exceeds its size limit");
        if (createHash("sha256").update(bytes).digest("hex") !== expected)
          throw new Error(`Upstream file changed: ${definition.name}/${path}`);
        try {
          files[path] = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          binaryFiles[path] = Buffer.from(bytes).toString("base64");
        }
      })
    );
  }
  return assembleUpstreamPlugin(definition, files, binaryFiles);
}
