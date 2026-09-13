import { strict as assert } from "node:assert";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

export async function testNativeVoiceNote(input: {
  appPath: string;
  repository: string;
  directory: string;
  audio: string;
  serverUrl: string;
  username: string;
  password: string;
}) {
  const run = async (command: string[]) => {
    const child = Bun.spawn(command, {
      cwd: join(input.repository, "apps/mobile"),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CI: "1" },
    });
    const deadline = setTimeout(() => child.kill(), 180_000);
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(deadline);
    if (code !== 0) throw new Error(`${command[0]} failed: ${stderr.slice(-1800)}`);
    return stdout.trim();
  };
  const bundle = join(input.directory, "native.bundle");
  await run([
    "node",
    "node_modules/expo/bin/cli",
    "export:embed",
    "--entry-file",
    "test/voice-note-native.tsx",
    "--platform",
    "ios",
    "--dev",
    "false",
    "--minify",
    "false",
    "--max-workers",
    "2",
    "--bundle-output",
    bundle,
  ]);
  let result:
    | {
        error?: string;
        reports?: string[];
        text?: string;
        deliveries?: Array<{ botId: string; clientId: string; text: string }>;
      }
    | undefined;
  const coordinator = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/status") return new Response("packager-status:running");
      if (path === "/qa-config")
        return Response.json({
          serverUrl: input.serverUrl,
          username: input.username,
          password: input.password,
        });
      if (path === "/fixture.wav")
        return new Response(Bun.file(input.audio), { headers: { "content-type": "audio/wav" } });
      if (path === "/qa-report" && request.method === "POST") {
        result = await request.json();
        return new Response("ok");
      }
      if (path === "/qa-capture" && request.method === "POST") {
        const { name } = await request.json();
        if (!device || !["recording", "draft", "thread-recording"].includes(name))
          return new Response(null, { status: 400 });
        await run([
          "xcrun",
          "simctl",
          "io",
          device,
          "screenshot",
          join(input.directory, `native-${name}.png`),
        ]);
        return new Response("ok");
      }
      if (path.endsWith(".bundle"))
        return new Response(Bun.file(bundle), {
          headers: { "content-type": "application/javascript" },
        });
      return new Response(null, { status: 404 });
    },
  });
  let device: string | undefined;
  try {
    device = await run([
      "xcrun",
      "simctl",
      "create",
      "OpenTeam Voice Note QA",
      "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    ]);
    await run(["xcrun", "simctl", "boot", device]);
    await run(["xcrun", "simctl", "bootstatus", device, "-b"]);
    await run([
      "xcrun",
      "simctl",
      "spawn",
      device,
      "defaults",
      "write",
      "com.apple.keyboard.preferences",
      "DidShowContinuousPathIntroduction",
      "-bool",
      "true",
    ]);
    await run(["xcrun", "simctl", "install", device, input.appPath]);
    const bundleId = await run([
      "/usr/libexec/PlistBuddy",
      "-c",
      "Print CFBundleIdentifier",
      join(input.appPath, "Info.plist"),
    ]);
    await run(["xcrun", "simctl", "privacy", device, "revoke", "microphone", bundleId]);
    await run([
      "xcrun",
      "simctl",
      "spawn",
      device,
      "defaults",
      "write",
      bundleId,
      "RCT_jsLocation",
      "-string",
      `127.0.0.1:${coordinator.port}`,
    ]);
    await run(["xcrun", "simctl", "launch", device, bundleId]);
    const deadline = Date.now() + 150_000;
    while (!result && Date.now() < deadline) await Bun.sleep(100);
    await run(["xcrun", "simctl", "io", device, "screenshot", join(input.directory, "native.png")]);
    assert(result, `Native test timed out; inspect ${input.directory}/native.png`);
    await writeFile(join(input.directory, "native-results.json"), JSON.stringify(result, null, 2));
    assert(!result.error, result.error);
    return result;
  } finally {
    await coordinator.stop(true);
    if (device) {
      await run(["xcrun", "simctl", "shutdown", device]).catch(() => undefined);
      await run(["xcrun", "simctl", "delete", device]);
    }
  }
}
