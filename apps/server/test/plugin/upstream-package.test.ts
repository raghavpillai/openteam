import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { importPackage, type PluginDefinition } from "@openteam/plugin-sdk";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { resolveUpstreamPlugin } from "../../src/plugins/upstream-package";

const originals = {
  ".cursor-plugin/plugin.json": JSON.stringify({ name: "upstream", version: "3.0.0" }),
  ".mcp.json": JSON.stringify({
    mcpServers: { provider: { url: "https://provider.example/mcp" } },
  }),
  "skills/context/SKILL.md":
    "---\r\nname: context\r\ndescription: 'Source description'\r\ncustom-field: retained\r\n---\r\n\r\nRead [reference](reference.md).\r\n",
  "skills/context/reference.md": "\uFEFFProvider reference.\n",
  "commands/upstream-brief.md": "---\ndescription: Brief\n---\nSummarize $ARGUMENTS",
  "skills/second/SKILL.md":
    "---\nname: second\ndescription: Second workflow\n---\nMore instructions.\n",
};
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture(): PluginDefinition {
  return {
    ...importPackage({ "plugin.json": JSON.stringify({ name: "host", version: "1.0.0" }) })
      .definition,
    files: {},
    components: ["mcp"],
    connections: [
      {
        key: "stable-account",
        name: "Provider",
        transport: "http",
        auth: "oauth",
        endpoint: "https://provider.example/mcp",
        tools: [],
      },
    ],
    upstream: {
      repository: "provider/plugin",
      revision: "a".repeat(40),
      directory: "plugins/example",
      delivery: "install",
      license: null,
      files: Object.fromEntries(
        Object.entries(originals).map(([path, body]) => [path, digest(body)])
      ),
    },
  };
}
test("source installation verifies immutable files and keeps host OAuth, binary assets, and exact ZIP bytes", async () => {
  const definition = fixture();
  const binary = new Uint8Array([0, 255, 128, 1]);
  definition.upstream!.files["assets/picture.png"] = createHash("sha256")
    .update(binary)
    .digest("hex");
  const requests: string[] = [];
  const request = async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    expect(url).toStartWith(
      `https://raw.githubusercontent.com/provider/plugin/${"a".repeat(40)}/plugins/example/`
    );
    const path = url.split("/plugins/example/")[1]!;
    return new Response(
      path === "assets/picture.png" ? binary : originals[path as keyof typeof originals]
    );
  };
  const installed = await resolveUpstreamPlugin(definition, request);
  expect(requests).toHaveLength(7);
  expect(installed.connections).toEqual(definition.connections);
  expect(installed.skills[0]?.path).toBe("upstream/skills/context");
  const exported = importPackageArchive(exportPackageArchive(installed)).definition;
  for (const [path, body] of Object.entries(originals))
    expect(exported.files?.[`upstream/${path}`]).toBe(body);
  expect(Buffer.from(exported.binaryFiles!["upstream/assets/picture.png"]!, "base64")).toEqual(
    Buffer.from(binary)
  );
  const offline = async () => {
    throw new Error("Offline");
  };
  expect(await resolveUpstreamPlugin(exported, offline)).toEqual(installed);
  expect(await resolveUpstreamPlugin(definition, offline, installed)).toEqual(installed);
  const reordered = structuredClone(definition);
  reordered.upstream!.files = Object.fromEntries(
    Object.entries(reordered.upstream!.files).reverse()
  );
  expect(await resolveUpstreamPlugin(reordered, request)).toEqual(installed);
  const stale = structuredClone(installed);
  stale.files!["upstream/commands/removed.md"] = "Stale command";
  expect(
    (await resolveUpstreamPlugin(stale, offline)).files?.["upstream/commands/removed.md"]
  ).toBeUndefined();
});
test("corruption and unavailable sources fail before a replacement package is produced", async () => {
  await expect(
    resolveUpstreamPlugin(fixture(), async () => new Response("wrong bytes"))
  ).rejects.toThrow("Upstream file changed");
  await expect(
    resolveUpstreamPlugin(fixture(), async () => new Response("missing", { status: 404 }))
  ).rejects.toThrow("Cannot download");
  await expect(
    resolveUpstreamPlugin(
      fixture(),
      async () => new Response("x", { headers: { "content-length": String(21 * 1024 * 1024) } })
    )
  ).rejects.toThrow("size limit");
  const unsafe = fixture();
  unsafe.upstream!.files["../../secret"] = "0".repeat(64);
  let called = false;
  await expect(
    resolveUpstreamPlugin(unsafe, async () => {
      called = true;
      return new Response();
    })
  ).rejects.toThrow("Unsafe package path");
  expect(called).toBe(false);
});
