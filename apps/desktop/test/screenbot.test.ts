import { describe, expect, test } from "bun:test";
import { applicationMenuTemplate } from "../src/main/application-menu";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScreenBotRoster } from "../src/main/screenbot-roster";
import { sweepIncompleteDeliveryStages } from "../src/main/delivery-file-stage";
import { spring } from "../src/renderer/screenbot/motion";

const bot = { id: "b1", name: "Atlas", title: "Research", color: "#27baae", icon: "classic", channelId: "c1" };

describe("screenbot roster", () => {
  test("keeps only the fields the overlay renders", () => {
    const roster = parseScreenBotRoster({
      bots: [{ ...bot, instructions: "secret", avatarDataUrl: "data:image/png;base64,AA" }],
    });
    expect(roster).toEqual({ bots: [{ ...bot, avatarDataUrl: "data:image/png;base64,AA" }], dictation: false });
  });

  test("drops avatars that aren't image data URLs", () => {
    const roster = parseScreenBotRoster({ bots: [{ ...bot, avatarDataUrl: "https://example.com/a.png" }], dictation: true });
    expect(roster).toEqual({ bots: [bot], dictation: true });
  });

  test("rejects malformed rosters", () => {
    expect(parseScreenBotRoster(null)).toBeNull();
    expect(parseScreenBotRoster({ bots: [{ id: "b1" }] })).toBeNull();
    expect(parseScreenBotRoster({ bots: [{ ...bot, channelId: "" }] })).toBeNull();
    expect(parseScreenBotRoster({ bots: "nope" })).toBeNull();
  });
});

describe("screenbot roster theme", () => {
  test("carries only a known appearance setting to the overlay", () => {
    const bots = [{ id: "b", name: "B", color: "#000", icon: "bot", channelId: "c" }];
    expect(parseScreenBotRoster({ bots, dictation: true, theme: "dark" })?.theme).toBe("dark");
    expect(parseScreenBotRoster({ bots, dictation: true, theme: "neon" })?.theme).toBeUndefined();
  });
});

describe("delivery staging sweep", () => {
  test("drops old half-written stages and keeps finished ones and fresh writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stage-sweep-"));
    try {
      await writeFile(join(directory, "aaaaaaaa-1111"), "finished");
      await writeFile(join(directory, "bbbbbbbb-2222.next"), "crashed mid-write");
      await writeFile(join(directory, "cccccccc-3333.next"), "being written now");
      const old = new Date(Date.now() - 60 * 60_000);
      await utimes(join(directory, "bbbbbbbb-2222.next"), old, old);
      expect(await sweepIncompleteDeliveryStages(directory)).toBe(1);
      expect((await readdir(directory)).sort()).toEqual(["aaaaaaaa-1111", "cccccccc-3333.next"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("screenbot springs", () => {
  test("start at rest, overshoot when underdamped, and settle at 1", () => {
    const bouncy = spring(300, 19);
    expect(bouncy.at(0)).toBeCloseTo(0, 6);
    expect(bouncy.velocity(0)).toBeCloseTo(0, 6);
    const peak = Math.max(...Array.from({ length: 200 }, (_, index) => bouncy.at(index / 200)));
    expect(peak).toBeGreaterThan(1);
    expect(bouncy.at(bouncy.duration)).toBeCloseTo(1, 2);
  });

  test("critically damped springs never overshoot", () => {
    const calm = spring(100, 20);
    for (let t = 0; t < calm.duration; t += 0.01) expect(calm.at(t)).toBeLessThanOrEqual(1 + 1e-9);
    expect(calm.at(calm.duration)).toBeCloseTo(1, 2);
  });
});

test("the File menu offers Open ScreenBot and shows an ordinary shortcut without claiming it", () => {
  const actions: string[] = [];
  const template = applicationMenuTemplate("darwin", (action) => actions.push(action), undefined, "CommandOrControl+Shift+2");
  const file = template.find((item) => item.label === "File");
  const items = file?.submenu as Array<{ label?: string; accelerator?: string; registerAccelerator?: boolean; click?: () => void }>;
  const screenbot = items.find((item) => item.label === "Open ScreenBot");
  expect(screenbot?.accelerator).toBe("CommandOrControl+Shift+2");
  expect(screenbot?.registerAccelerator).toBe(false);
  screenbot?.click?.();
  expect(actions).toEqual(["screenbot"]);
  expect(items.some((item) => (item as { role?: string }).role === "close")).toBe(true);
  // A both-key chord can't be shown as a menu accelerator.
  const chordMenu = applicationMenuTemplate("darwin", () => {}, undefined, null);
  const chordItems = chordMenu.find((item) => item.label === "File")?.submenu as Array<{ label?: string; accelerator?: string }>;
  expect(chordItems.find((item) => item.label === "Open ScreenBot")?.accelerator).toBeUndefined();
});

describe("screenbot PNG encoder", () => {
  test("round-trips BGRA screen pixels as an RGB PNG", async () => {
    const { encodeScreenPng } = await import("../src/main/screenbot-png");
    const { inflateSync, crc32 } = await import("node:zlib");
    const width = 37, height = 29;
    const bgra = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      bgra[i * 4] = (i * 7) & 0xff;      // blue
      bgra[i * 4 + 1] = (i * 13) & 0xff; // green
      bgra[i * 4 + 2] = (i * 29) & 0xff; // red
      bgra[i * 4 + 3] = 255;
    }
    const png = await encodeScreenPng(bgra, width, height);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // Walk the chunks, checking each CRC, and collect the image data.
    let offset = 8;
    const idat: Buffer[] = [];
    let header: Buffer | null = null;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const type = png.subarray(offset + 4, offset + 8).toString("ascii");
      const data = png.subarray(offset + 8, offset + 8 + length);
      expect(png.readUInt32BE(offset + 8 + length)).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)) >>> 0);
      if (type === "IHDR") header = data;
      if (type === "IDAT") idat.push(data);
      offset += 12 + length;
    }
    expect(header?.readUInt32BE(0)).toBe(width);
    expect(header?.readUInt32BE(4)).toBe(height);
    expect(header?.[9]).toBe(2);
    const raw = inflateSync(Buffer.concat(idat));
    const rowBytes = width * 3 + 1;
    for (let y = 0; y < height; y += 1) {
      expect(raw[y * rowBytes]).toBe(1);
      let previous = [0, 0, 0];
      for (let x = 0; x < width; x += 1) {
        const pixel = [0, 1, 2].map((channel) => (raw[y * rowBytes + 1 + x * 3 + channel]! + previous[channel]!) & 0xff);
        const i = (y * width + x) * 4;
        expect(pixel).toEqual([bgra[i + 2], bgra[i + 1], bgra[i]]);
        previous = pixel;
      }
    }
  });
});

test("a dropped shot stops its PNG encode at the next slice", async () => {
  const { encodeScreenPng } = await import("../src/main/screenbot-png");
  const width = 64, height = 400;
  const pixels = new Uint8Array(width * height * 4).fill(200);
  const controller = new AbortController();
  const encoding = encodeScreenPng(pixels, width, height, "bgra", controller.signal);
  controller.abort();
  await expect(encoding).rejects.toThrow("cancelled");
  // Without a signal, the same pixels encode normally.
  const png = await encodeScreenPng(pixels, width, height);
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
});
