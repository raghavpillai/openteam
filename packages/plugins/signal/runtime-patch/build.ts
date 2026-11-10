import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zipSync } from "fflate";

// Maintainer build only. Connection/install uses the checked-in JAR and the pinned JRE.
const root = import.meta.dir;
const jdk = process.env.SIGNAL_PATCH_JDK;
const cli = process.env.SIGNAL_PATCH_CLI;
if (!jdk || !cli)
  throw new Error(
    "Set SIGNAL_PATCH_JDK to JDK 25 and SIGNAL_PATCH_CLI to the pinned signal-cli 0.14.10 distribution."
  );
const temporary = await mkdtemp(join(tmpdir(), "openteam-signal-patch-"));
async function files(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(directory, join(prefix, entry.name))
          : [join(prefix, entry.name)]
      )
    )
  )
    .flat()
    .sort();
}
try {
  const sources = await files(join(root, "src"));
  const child = Bun.spawn(
    [
      join(resolve(jdk), "bin/javac"),
      "--release",
      "25",
      "-proc:none",
      "-g:none",
      "-encoding",
      "UTF-8",
      "-classpath",
      join(resolve(cli), "lib/*"),
      "-d",
      temporary,
      ...sources.map((path) => join(root, "src", path)),
    ],
    { stdout: "inherit", stderr: "inherit" }
  );
  if (await child.exited) throw new Error("Signal compatibility patch compilation failed");
  const entries: Record<string, Uint8Array> = {
    "META-INF/MANIFEST.MF": new TextEncoder().encode(
      "Manifest-Version: 1.0\nImplementation-Title: signal-cli\nImplementation-Version: 0.14.10\nOpenTeam-Patch-Version: 0.14.10-ot.1\n\n"
    ),
  };
  for (const path of await files(temporary)) entries[path] = await readFile(join(temporary, path));
  // Ship corresponding modified sources alongside the binary, including inside exports of the JAR.
  for (const path of sources)
    entries[`META-INF/source/${path}`] = await readFile(join(root, "src", path));
  entries["META-INF/LICENSE"] = await readFile(join(root, "LICENSE"));
  const jar = zipSync(
    Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    { level: 9, mtime: new Date(1980, 0, 1, 0, 0, 0) }
  );
  const destination = join(root, "signal-cli-0.14.10-ot.1.jar");
  if (process.argv.includes("--check")) {
    if (!Buffer.from(await readFile(destination)).equals(Buffer.from(jar)))
      throw new Error("Checked-in Signal compatibility JAR differs from its sources");
  } else await writeFile(destination, jar);
  console.log(
    JSON.stringify({
      patch: "0.14.10-ot.1",
      bytes: jar.length,
      sha256: createHash("sha256").update(jar).digest("hex"),
      verified: true,
    })
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
