import { describe, expect, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { applicationMenuTemplate } from "../src/main/application-menu";
import { parseAppshotRoster } from "../src/main/appshot-roster";

const bot = { id: "b1", name: "Atlas", title: "Research", color: "#27baae", icon: "classic", channelId: "c1" };

describe("appshot roster", () => {
  test("keeps only the fields the overlay renders", () => {
    const roster = parseAppshotRoster({
      bots: [{ ...bot, instructions: "secret", avatarDataUrl: "data:image/png;base64,AA" }],
    });
    expect(roster).toEqual({ bots: [{ ...bot, avatarDataUrl: "data:image/png;base64,AA" }], dictation: false });
  });

  test("drops avatars that aren't image data URLs", () => {
    const roster = parseAppshotRoster({ bots: [{ ...bot, avatarDataUrl: "https://example.com/a.png" }], dictation: true });
    expect(roster).toEqual({ bots: [bot], dictation: true });
  });

  test("rejects malformed rosters", () => {
    expect(parseAppshotRoster(null)).toBeNull();
    expect(parseAppshotRoster({ bots: [{ id: "b1" }] })).toBeNull();
    expect(parseAppshotRoster({ bots: [{ ...bot, channelId: "" }] })).toBeNull();
    expect(parseAppshotRoster({ bots: "nope" })).toBeNull();
  });
});

test("the File menu offers Take Appshot and shows an ordinary shortcut without claiming it", () => {
  const actions: string[] = [];
  const template = applicationMenuTemplate("darwin", (action) => actions.push(action), undefined, "CommandOrControl+Shift+2");
  const file = template.find((item) => item.label === "File");
  const items = file?.submenu as Array<{ label?: string; accelerator?: string; registerAccelerator?: boolean; click?: () => void }>;
  const appshot = items.find((item) => item.label === "Take Appshot");
  expect(appshot?.accelerator).toBe("CommandOrControl+Shift+2");
  expect(appshot?.registerAccelerator).toBe(false);
  appshot?.click?.();
  expect(actions).toEqual(["appshot"]);
  expect(items.some((item) => (item as { role?: string }).role === "close")).toBe(true);
  // A both-key chord can't be shown as a menu accelerator.
  const chordMenu = applicationMenuTemplate("darwin", () => {}, undefined, null);
  const chordItems = chordMenu.find((item) => item.label === "File")?.submenu as Array<{ label?: string; accelerator?: string }>;
  expect(chordItems.find((item) => item.label === "Take Appshot")?.accelerator).toBeUndefined();
});

test("Edit clipboard actions route to the computer only when it owns focus", () => {
  let computerActive = true;
  const remote: string[] = [];
  const local: string[] = [];
  const window = { webContents: { copy: () => local.push("copy"), cut: () => local.push("cut"), paste: () => local.push("paste") } };
  const template = applicationMenuTemplate("darwin", () => {}, action => {
    if (!computerActive) return false;
    remote.push(action); return true;
  });
  const submenu = template.find(item => item.label === "Edit")?.submenu as MenuItemConstructorOptions[];
  for (const label of ["Copy", "Cut", "Paste"]) {
    const item = submenu.find(item => item.label === label)!;
    (item.click as Function)(item, window, {});
  }
  expect(remote).toEqual(["copy", "cut", "paste"]);
  expect(local).toEqual([]);
  computerActive = false;
  for (const label of ["Copy", "Cut", "Paste"]) {
    const item = submenu.find(item => item.label === label)!;
    (item.click as Function)(item, window, {});
  }
  expect(local).toEqual(["copy", "cut", "paste"]);
  expect(remote).toHaveLength(3);
});

describe("appshot PNG encoder", () => {
  test("round-trips BGRA screen pixels as an RGB PNG", async () => {
    const { encodeScreenPng } = await import("../src/main/appshot-png");
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
  const { encodeScreenPng } = await import("../src/main/appshot-png");
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
