// Runs fixture scripts under real Node (the box's runtime for network probes) against self-signed TLS servers.
import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A one-day self-signed certificate for `hosts` written as `<name>.pem` and `<name>.key` in `directory`. */
export async function selfSignedCertificate(directory: string, hosts: string[], name = "cert") {
  const cert = join(directory, `${name}.pem`), key = join(directory, `${name}.key`);
  const openssl = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
    "-subj", `/CN=${hosts[0]}`, "-addext", `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}`], { stdout: "ignore", stderr: "ignore" });
  expect(await openssl.exited).toBe(0);
  return { cert, key };
}

/** Bundles `entry` (a path, or TypeScript source to write) for Node, runs it with `args`, and returns its stdout. */
export async function runInNode(directory: string, entry: { path: string } | { source: string }, options: { args?: string[]; env?: Record<string, string>; timeoutMs?: number } = {}) {
  const path = "path" in entry ? entry.path : join(directory, "runner.ts");
  if ("source" in entry) await writeFile(path, entry.source);
  const output = join(directory, "runner.mjs");
  const build = Bun.spawn([process.execPath, "build", path, "--target", "node", "--outfile", output], { stdout: "ignore", stderr: "inherit" });
  expect(await build.exited).toBe(0);
  const child = Bun.spawn(["node", output, ...(options.args ?? [])], { env: { ...process.env, ...options.env }, stdout: "pipe", stderr: "pipe" });
  const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(stderr || stdout);
    return stdout;
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
