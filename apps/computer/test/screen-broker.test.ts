import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenBroker } from "../src/screen-broker";

describe("graphical screen lifecycle", () => {
  let home: string | undefined;

  afterEach(async () => {
    if (home) await rm(home, { force: true, recursive: true });
    home = undefined;
  });

  test("tombstones destroyed bots so a late inspector poll cannot recreate them", async () => {
    home = await mkdtemp(join(tmpdir(), "openbot-screen-broker-"));
    const stateRoot = join(home, ".openbot");
    const mappingPath = join(stateRoot, "screens.json");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(mappingPath, `${JSON.stringify({ "archived-bot": 4 })}\n`);

    const broker = new ScreenBroker(home);
    await broker.destroy("archived-bot");

    expect(JSON.parse(await readFile(mappingPath, "utf8"))).toEqual({});
    await expect(broker.status("archived-bot", "/workspace")).rejects.toThrow(
      "Graphical screen was destroyed"
    );
  });
});
