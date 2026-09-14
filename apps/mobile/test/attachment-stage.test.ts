import { expect, mock, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function checkStaging() {
  const cases: Array<() => Promise<void>> = [];
  const check = (_name: string, run: () => Promise<void>) => cases.push(run);
  const root = await mkdtemp(join(tmpdir(), "openteam-ios-input-"));
  // Exercise the shipping staging function with actual file copies/stat calls.
  // Only Expo's native filesystem bridge is replaced for the Bun runner.
  mock.module("expo-file-system/legacy", () => ({
    documentDirectory: `${root}/`,
    makeDirectoryAsync: (path: string) => mkdir(path, { recursive: true }),
    copyAsync: ({ from, to }: { from: string; to: string }) => copyFile(from, to),
    getInfoAsync: async (path: string) => ({ exists: true, size: (await stat(path)).size }),
    moveAsync: ({ from, to }: { from: string; to: string }) => rename(from, to),
    deleteAsync: (path: string) => rm(path, { force: true }),
  }));
  const { stageMobileDeliveryAttachment, discardMobileDeliveryAttachments } = await import(
    "../src/durable-attachment-stage"
  );

  const sizedFile = async (name: string, size: number) => {
    const path = join(root, name);
    const file = await open(path, "w");
    try {
      await file.truncate(size);
    } finally {
      await file.close();
    }
    return path;
  };

  check("uses copied bytes instead of trusting picker metadata", async () => {
    const uri = join(root, "unicode.txt");
    const bytes = Buffer.from("pine-λ-雪\nINPUT_PARITY_914");
    await writeFile(uri, bytes);
    const staged = await stageMobileDeliveryAttachment({
      uri,
      fileName: "unicode.txt",
      byteSize: 1,
    });
    expect(staged.byteSize).toBe(bytes.length);
    expect(await readFile(staged.previewUri!)).toEqual(bytes);
    await discardMobileDeliveryAttachments([staged]);
    expect(await readFile(uri)).toEqual(bytes);
  });

  check(
    "rejects an empty file and a concealed oversized file without leaving a partial stage",
    async () => {
      for (const [name, size, message] of [
        ["empty.txt", 0, '"empty.txt" is empty, so it wasn\'t attached.'],
        ["over.txt", 26_214_401, '"over.txt" is too large to attach (max 25 MB).'],
      ] as const) {
        const uri = await sizedFile(name, size);
        await expect(
          stageMobileDeliveryAttachment({ uri, fileName: name, byteSize: 1 })
        ).rejects.toThrow(message);
      }
      expect(await readdir(join(root, "durable-send-files"))).toEqual([]);
    }
  );

  check(
    "allows exact regular size and applies the larger allowance only to known video names",
    async () => {
      const uri = await sizedFile("boundary.bin", 26_214_400);
      const exact = await stageMobileDeliveryAttachment({ uri, fileName: "boundary.txt" });
      expect(exact.byteSize).toBe(26_214_400);
      await discardMobileDeliveryAttachments([exact]);
      const over = await sizedFile("video.bin", 26_214_401);
      const video = await stageMobileDeliveryAttachment({ uri: over, fileName: "video.MOV" });
      expect(video.byteSize).toBe(26_214_401);
      await discardMobileDeliveryAttachments([video]);
      await expect(
        stageMobileDeliveryAttachment({ uri: over, fileName: "video.mkv", mimeType: "video/mp4" })
      ).rejects.toThrow("max 25 MB");
    }
  );

  try {
    for (const check of cases) await check();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ passed: cases.length }));
}

if (process.env.OPENTEAM_INPUT_STAGE_PROBE === "1") {
  await checkStaging();
} else {
  test("iOS staging validates copied bytes, exact limits, and failure cleanup", async () => {
    // Separate process prevents Expo bridge mocks leaking into cache/draft tests.
    const output = await mkdtemp(join(tmpdir(), "openteam-ios-stage-result-"));
    const resultPath = join(output, "result.json");
    try {
      const child = Bun.spawn([process.execPath, "run", fileURLToPath(import.meta.url)], {
        env: { ...process.env, OPENTEAM_INPUT_STAGE_PROBE: "1" },
        // A regular file avoids losing the short-lived child's output when Bun
        // closes a subprocess pipe before the test runner drains it on macOS.
        stdout: Bun.file(resultPath),
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({ passed: 3 });
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
}
