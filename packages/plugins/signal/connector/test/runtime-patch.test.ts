import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { pluginCatalog } from "../../../src";

const patch = new URL("../../runtime-patch", import.meta.url).pathname;
const jar = join(patch, "signal-cli-0.14.10-ot.1.jar");
const { SIGNAL_PATCH_JDK: jdk, SIGNAL_PATCH_CLI: cli, SIGNAL_TEST_EXECUTABLE: executable, SIGNAL_TEST_JAVA_HOME: javaHome, SIGNAL_TEST_LIBSIGNAL: libsignal } = process.env;

test("bundled compatibility JAR contains exactly its distributed corresponding source", async () => {
  const entries = unzipSync(new Uint8Array(await readFile(jar)));
  const sources = (await readdir(join(patch, "src"), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(join(patch, "src").length + 1));
  expect(sources).toHaveLength(4);
  expect(Object.keys(entries).filter((path) => path.startsWith("META-INF/source/")).sort()).toEqual(sources.map((path) => `META-INF/source/${path}`).sort());
  for (const path of sources) expect(Buffer.from(entries[`META-INF/source/${path}`]!)).toEqual(await readFile(join(patch, "src", path)));
  expect(new TextDecoder().decode(entries["META-INF/MANIFEST.MF"])).toContain("OpenTeam-Patch-Version: 0.14.10-ot.1");
  expect(entries["org/asamk/signal/OpenTeamMain.class"]).toBeDefined();
  expect(entries["org/asamk/signal/manager/api/SyncDeletions.class"]).toBeDefined();
});

test.skipIf(!jdk || !cli)("patch rebuild is byte-identical and real protobufs preserve deletion addressing through JSON", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "signal-patch-probe-"));
  const classpath = `${jar}:${join(cli!, "lib/*")}`;
  const run = async (args: string[]) => {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: process.env });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    return out;
  };
  try {
    await run([process.execPath, join(patch, "build.ts"), "--check"]);
    await run([join(jdk!, "bin/javac"), "--release", "25", "-proc:none", "-cp", classpath, "-d", temporary, new URL("PatchProbe.java", import.meta.url).pathname]);
    expect(await run([join(jdk!, "bin/java"), "--enable-native-access=ALL-UNNAMED", ...(libsignal ? [`-Djava.library.path=${dirname(libsignal)}`] : []),
      "-cp", `${temporary}:${classpath}`, "org.asamk.signal.manager.storage.recipients.PatchProbe"]))
      .toContain("Patched real protobuf -> authenticated content -> manager -> JSON: passed");
    expect((await run([join(jdk!, "bin/java"), "-cp", classpath, "org.asamk.signal.OpenTeamMain", "--openteam-patch-version"])).trim()).toBe("0.14.10-ot.1");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(!executable || !javaHome)("exported package launches the patched real runtime with an empty private account", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "signal-packaged-patch-"));
  let client: Client | undefined;
  try {
    const imported = importPackageArchive(exportPackageArchive(pluginCatalog.find((entry) => entry.key === "signal")!)).definition;
    const directory = join(temporary, "package");
    for (const [path, value] of [...Object.entries(imported.files ?? {}), ...Object.entries(imported.binaryFiles ?? {}).map(([path, value]) => [path, Buffer.from(value, "base64")] as const)]) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), value);
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(directory, "connector/server.mjs")],
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        OPENTEAM_RUNTIME_SIGNAL_CLI: executable!,
        OPENTEAM_RUNTIME_JAVA: join(javaHome!, "bin/java"),
        ...(libsignal ? { OPENTEAM_RUNTIME_LIBSIGNAL: libsignal } : {}),
        OPENTEAM_PLUGIN_ACCOUNT_ID: "synthetic-patched-package",
        OPENTEAM_PLUGIN_STATE_DIR: join(temporary, "account"),
      },
    });
    transport.stderr?.on("data", () => {});
    client = new Client({ name: "signal-packaged-runtime-test", version: "1" });
    await client.connect(transport);
    const result = await client.callTool({ name: "signal_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ linked: false, runtimeVersion: "0.14.10", runtimePatch: "0.14.10-ot.1" });
    expect((await client.listTools()).tools.filter((tool) => tool._meta?.["openteam/hostOnly"] !== true)).toHaveLength(5);
    expect((await client.callTool({ name: "list_contacts", arguments: {} })).isError).toBe(true);
  } finally {
    await client?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);
