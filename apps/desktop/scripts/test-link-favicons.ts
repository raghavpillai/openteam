import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

// Link favicons in chat messages: a skeleton while an icon loads, the icon once
// it arrives, a globe when the site has none, all without reflowing the text.
// Pass a directory to keep the screenshots.
const require = createRequire(import.meta.url);
const keep = process.argv[2];
const directory = keep ? resolve(keep) : await mkdtemp(join(tmpdir(), "openteam-link-favicons-"));
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  server: { port: 0, strictPort: false },
});
type Icon = { host: string; state: string; width: number; height: number };
type Snapshot = { states: Icon[]; text: { width: number; height: number }; settled?: boolean };
try {
  await server.listen();
  await Bun.$`mkdir -p ${directory}`;
  const child = Bun.spawn(
    [require("electron") as string, resolve(import.meta.dir, "../test/browser/link-favicons-runner.cjs")],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        LINK_FAVICONS_DIR: directory,
        LINK_FAVICONS_URL: `${server.resolvedUrls!.local[0]}test/browser/link-favicons.html`,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timeout = setTimeout(() => child.kill(), 90_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if (code) throw new Error(`Electron failed: ${stderr}`);
  const results = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  if (results.error) throw new Error(results.error);
  const failures: string[] = [];
  const expect = (condition: boolean, message: string) => { if (!condition) failures.push(message); };
  for (const theme of ["light", "dark"]) {
    const { loading, settled, hover } = results[theme] as {
      loading: Snapshot; settled: Snapshot; hover: { card: number[]; label: number[]; text: string } | null;
    };
    expect(hover !== null, `${theme}: hovering a link should show its address card`);
    if (hover) {
      const [cardX, cardY, cardWidth, cardHeight] = hover.card as [number, number, number, number];
      const [labelX, labelY, labelWidth] = hover.label as [number, number, number];
      const iconSlot = 22; // The 18px icon slot and its 4px gap center the card on the whole link.
      expect(Math.abs(cardY + cardHeight + 8 - labelY) < 3, `${theme}: card should sit 8px above the link: ${JSON.stringify(hover)}`);
      expect(Math.abs(cardX + cardWidth / 2 - (labelX - iconSlot + (labelWidth + iconSlot) / 2)) < 3, `${theme}: card should center on the link`);
      expect(hover.text.startsWith("fast.example/wiki/Special:Random"), `${theme}: card shows host and path: ${hover.text}`);
    }
    const at = (snapshot: Snapshot, host: string) => snapshot.states.filter((icon) => icon.host === host);
    const slow = `slow-${theme}.example`;
    expect(loading.states.length === 5, `${theme}: expected five web-link icons, got ${loading.states.length}`);
    expect(at(loading, slow).every((icon) => icon.state === "loading"), `${theme}: slow icon should show its skeleton`);
    expect(at(loading, "fast.example").every((icon) => icon.state === "loaded"), `${theme}: fast icons should load`);
    expect(settled.settled === true, `${theme}: icons never settled`);
    expect(at(settled, slow).every((icon) => icon.state === "loaded"), `${theme}: slow icon should load`);
    expect(at(settled, "none.example").every((icon) => icon.state === "missing"), `${theme}: icon-less site should show a globe`);
    const sizes = [...loading.states, ...settled.states];
    expect(sizes.every((icon) => Math.abs(icon.width - sizes[0]!.width) < 0.5 && Math.abs(icon.height - icon.width) < 0.5),
      `${theme}: every icon state should be the same square: ${JSON.stringify(sizes)}`);
    expect(Math.abs(loading.text.height - settled.text.height) < 0.5 && Math.abs(loading.text.width - settled.text.width) < 0.5,
      `${theme}: text reflowed when icons arrived`);
  }
  // One request per site with an icon, however many links and pages show it.
  for (const host of ["fast.example", "slow-light.example", "slow-dark.example"]) {
    const count = (results.requests as string[]).filter((requested) => requested === host).length;
    expect(count === 1, `${host}: expected one request, got ${count}`);
  }
  console.log(JSON.stringify({ ...results, screenshots: directory }, null, 2));
  if (failures.length) throw new Error(failures.join("\n"));
  console.log("Link favicons: skeleton, icon and globe states hold their space in both themes.");
} finally {
  await server.close();
  if (!keep) await rm(directory, { recursive: true, force: true });
}
