import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { substituteConfiguration, validateValues } from "@openteam/plugin-sdk";
import { pluginCatalog } from "../src";

test("iMessage read-only reader, SSH restrictions and authenticated MCP endpoint behavior", async () => {
  const directory = fileURLToPath(new URL("../imessage-ssh/connector/test", import.meta.url));
  const child = Bun.spawn(["python3", "-m", "unittest", "discover", "-s", directory], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code) throw new Error(`iMessage behavior tests failed: ${output}\n${errors}`);
  expect(code).toBe(0);
}, 15_000);

test("iMessage Marketplace package round trips its helper, skill and configurable endpoint", () => {
  const plugin = pluginCatalog.find(p => p.key === "imessage-ssh")!;
  const roundtrip = importPackageArchive(exportPackageArchive(plugin)).definition;
  for (const path of ["connector/reader.py", "connector/gateway.py", "connector/install-reader.py"])
    expect(roundtrip.files?.[path]).toBe(plugin.files?.[path]);
  expect(roundtrip.skills[0]!.body.trim()).toBe(plugin.skills[0]!.body.trim());
  const fields = plugin.setup!.fields;
  const values = validateValues(fields, { GATEWAY_ADDRESS: "172.18.0.1:8799", token: "example-only" });
  expect(substituteConfiguration(plugin.connections[0]!.endpoint, values)).toBe("http://172.18.0.1:8799/mcp");
  expect(fields.find(f => f.key === "token")?.secret).toBe(true);
  expect(Object.keys(roundtrip.files ?? {}).some(path => /(?:^|\/)(?:id_ed25519|known_hosts|config\.json|token)$/.test(path))).toBe(false);
});
