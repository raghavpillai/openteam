import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { TranscriptMirror } from "../src/transcript-mirror";
import { tempDirs } from "./temp";
const tempDir = tempDirs();

const botId = "329595e8-39a7-441e-9cf1-505b5d5948fe";
let home: string | null = null;

afterEach(async () => {
  home = null;
});

describe("safe transcript mirror", () => {
  test("atomically writes one private JSONL projection per bot", async () => {
    home = await tempDir("openteam-transcript-");
    const mirror = new TranscriptMirror(home);
    const result = await mirror.replace({
      botId,
      generatedAt: new Date(0).toISOString(),
      events: [
        {
          schemaVersion: 1,
          id: "message:1",
          botId,
          at: new Date(0).toISOString(),
          type: "visible_message",
          channel: { id: botId, kind: "bot_dm", name: "New Bot" },
          sender: { kind: "user", botId: null, name: "User" },
          content: "hello",
          metadata: { type: "text" },
        },
      ],
    });
    expect(result.events).toBe(1);
    expect(await readFile(result.path, "utf8")).toContain('"content":"hello"');
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
  });

  test("rejects path-shaped bot ids", async () => {
    home = await tempDir("openteam-transcript-");
    const mirror = new TranscriptMirror(home);
    await expect(
      mirror.replace({ botId: "../../escape", generatedAt: new Date().toISOString(), events: [] })
    ).rejects.toThrow("Invalid transcript bot id");
  });
});
