import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { ApnsSettingsStore } from "@openteam/db/apns-settings";
import { internalNotificationsRoute } from "../../server/src/routes/internal-notifications";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
  "CLI imports and rotates encrypted APNs keys while the same Node worker stays alive",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "openteam-apns-runtime-"));
    const prisma = createPrismaClient(databaseUrl!);
    const secret = "isolated-apns-runtime-test-control-token";
    const settings = new ApnsSettingsStore(prisma, () => secret);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        internalNotificationsRoute(
          request,
          settings,
          (request) => request.headers.get("authorization") === `Bearer ${secret}`
        ),
    });
    let worker: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await prisma.apnsSettings.deleteMany();
      const environment = `OPENTEAM_CONTROL_TOKEN=${secret}\nOPENTEAM_API_PORT=${server.port}\nOPENTEAM_BIND_HOST=127.0.0.1\n`;
      await writeFile(join(directory, ".env"), environment, { mode: 0o600 });
      // Match production: bundled CLI and persistent Node worker are separate processes.
      const cliPath = join(directory, "cli.js");
      const workerPath = join(directory, "worker.js");
      const build = async (entrypoint: string, output: string) => {
        const built = await Bun.build({
          entrypoints: [entrypoint],
          target: "node",
          format: "esm",
          external: ["pg-native"],
        });
        if (!built.success) throw new Error("APNs test bundle failed");
        await writeFile(output, await built.outputs[0]!.text());
      };
      await build(resolve(import.meta.dir, "../../cli/src/main.ts"), cliPath);
      await build(resolve(import.meta.dir, "fixtures/apns-runtime-worker.ts"), workerPath);
      worker = Bun.spawn(["node", workerPath], {
        env: { ...process.env, DATABASE_URL: databaseUrl!, OPENTEAM_CONTROL_TOKEN: secret },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = (worker.stdout as ReadableStream<Uint8Array>).getReader();
      let buffered = "";
      const send = async (publicKey: string, topic = "dev.openbot.mobile") => {
        (worker!.stdin as { write: (value: string) => unknown }).write(
          JSON.stringify({ publicKey, topic }) + "\n"
        );
        while (!buffered.includes("\n")) {
          const part = await output.read();
          if (part.done) throw new Error("Runtime test worker stopped unexpectedly");
          buffered += Buffer.from(part.value).toString();
        }
        const newline = buffered.indexOf("\n");
        const value = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        return value;
      };
      const keyPair = () => {
        const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        return {
          privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        };
      };
      const first = keyPair(),
        second = keyPair();
      const metadata = { keyId: "ABCDE12345", teamId: "FGHIJ67890", topic: "dev.openbot.mobile" };
      await writeFile(
        join(directory, "apns.json"),
        JSON.stringify({ ...metadata, privateKeyFile: "AuthKey.p8" })
      );
      const configure = async (privateKey: string) => {
        await writeFile(join(directory, "AuthKey.p8"), privateKey, { mode: 0o600 });
        const command = Bun.spawn(
          [
            "node",
            cliPath,
            "notifications",
            "configure",
            "--dir",
            directory,
            "--config",
            join(directory, "apns.json"),
          ],
          { stdout: "pipe", stderr: "pipe" }
        );
        const stdout = await new Response(command.stdout).text();
        const stderr = await new Response(command.stderr).text();
        expect(await command.exited).toBe(0);
        expect(stderr).toBe("");
        expect(stdout).toContain("no restart needed");
        expect(stdout).not.toContain(privateKey);
      };
      const unauthorized = await fetch(server.url, {
        method: "PATCH",
        body: JSON.stringify({ ...metadata, privateKey: first.privateKey }),
      });
      expect(unauthorized.status).toBe(401);
      expect(await prisma.apnsSettings.count()).toBe(0);
      await configure(first.privateKey);
      const before = await send(first.publicKey);
      expect(before).toMatchObject({
        ...metadata,
        verified: true,
        authority: "https://api.push.apple.com",
      });
      // Rotate the key with identical IDs: this catches cached JWT reuse as well as stale config.
      await configure(second.privateKey);
      const after = await send(second.publicKey);
      expect(after).toMatchObject({ ...metadata, verified: true, pid: before.pid });
      expect(
        (await prisma.apnsSettings.findUniqueOrThrow({ where: { id: "global" } }))
          .encryptedPrivateKey
      ).not.toContain("PRIVATE KEY");
      expect(await readFile(join(directory, ".env"), "utf8")).toBe(environment);
      const statusCommand = Bun.spawn(
        ["node", cliPath, "notifications", "status", "--dir", directory],
        { stdout: "pipe", stderr: "pipe" }
      );
      const statusOutput = await new Response(statusCommand.stdout).text();
      expect(await statusCommand.exited).toBe(0);
      expect(statusOutput).toContain("source: database");
      expect(statusOutput).not.toContain("PRIVATE KEY");
      const safeStatus = await fetch(server.url, {
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(await safeStatus.json()).toMatchObject({
        ...metadata,
        source: "database",
        missing: [],
        issue: null,
      });
      const changed = {
        ...metadata,
        keyId: "12345ABCDE",
        teamId: "67890FGHIJ",
        topic: "dev.test.rotated",
      };
      const rotation = await fetch(server.url, {
        method: "PATCH",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ ...changed, privateKey: first.privateKey }),
      });
      expect(rotation.status).toBe(200);
      expect(await send(first.publicKey, changed.topic)).toMatchObject({
        ...changed,
        verified: true,
        pid: before.pid,
      });
      // Authentication failure must not cause fallback to an older environment key.
      await prisma.apnsSettings.update({
        where: { id: "global" },
        data: { encryptedPrivateKey: "enc:v1:broken" },
      });
      expect(await send(first.publicKey, changed.topic)).toMatchObject({
        failed: true,
        pid: before.pid,
      });
      expect(await settings.status()).toMatchObject({ issue: "runtime-settings" });
      const rejected = await fetch(server.url, {
        method: "PATCH",
        headers: { authorization: `Bearer ${secret}` },
        body: JSON.stringify({ ...metadata, privateKey: "secret-invalid-value" }),
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).not.toContain("secret-invalid-value");
    } finally {
      worker?.kill();
      if (worker) await worker.exited;
      server.stop(true);
      await prisma.apnsSettings.deleteMany();
      await prisma.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000
);
