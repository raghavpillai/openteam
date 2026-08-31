import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BotTranscriptView } from "@openbot/contracts";

const BOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TranscriptMirror {
  readonly root: string;

  constructor(home = process.env.HOME ?? "/home/box") {
    this.root = join(home, "agent-data", "agent-transcripts");
  }

  async replace(transcript: BotTranscriptView): Promise<{ path: string; events: number }> {
    if (!BOT_ID.test(transcript.botId)) throw new Error("Invalid transcript bot id");
    const directory = join(this.root, transcript.botId);
    const path = join(directory, `${transcript.botId}.jsonl`);
    const temporary = join(directory, `.${transcript.botId}.${crypto.randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const lines = transcript.events.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(temporary, lines.length > 0 ? `${lines}\n` : "", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
    return { path, events: transcript.events.length };
  }
}
