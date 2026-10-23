import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";

// Run inside a built computer image with scripts/test-computer-image.sh IMAGE, which
// passes the user's zone as OPENTEAM_TEST_TIME_ZONE. The computer applies a turn's zone
// with the clock script, as below. Box shells get no TZ variable (as the Shell tool's do
// not), so every reading below comes from the box clock itself.
const zone = process.env.OPENTEAM_TEST_TIME_ZONE;
const inImage = Boolean(process.env.OPENTEAM_COMPUTER_TEST_URL && zone);

const asBox = (script: string) => {
  const run = spawnSync("runuser", ["-u", "box", "--", "env", "-u", "TZ", "bash", "-c", script], { encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.trim();
};
const applyZone = (value: string) =>
  spawnSync("/usr/local/bin/openteam-box-timezone", ["apply", value], { encoding: "utf8" });

/** `date +%z` style offset of the configured zone at a moment, from Intl's own data. */
const offset = (date: Date, timeZone = zone!) => {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")!.value;
  const match = name.match(/^GMT([+-]\d{2}):(\d{2})$/);
  return match ? `${match[1]}${match[2]}` : "+0000";
};

beforeAll(() => {
  if (inImage) expect(applyZone(zone!).status).toBe(0);
});

test.skipIf(inImage)("the computer image ships the clock script and zone data", async () => {
  const file = (path: string) => Bun.file(new URL(`../../../${path}`, import.meta.url)).text();
  const dockerfile = await file("docker/computer.Dockerfile");
  expect(dockerfile).toMatch(/apt-get install[\s\S]*?\btzdata\b/);
  expect(dockerfile).toContain("COPY docker/openteam-box-timezone /usr/local/bin/openteam-box-timezone");
});

test.skipIf(!inImage)("the box clock runs in the configured time zone", () => {
  expect(realpathSync("/etc/localtime")).toBe(realpathSync(`/usr/share/zoneinfo/${zone}`));
  expect(readFileSync("/etc/timezone", "utf8").trim()).toBe(zone!);
  // ICU may name the zone by an alias (Asia/Calcutta), so compare offsets.
  const readings = asBox(
    `date +%z; node -e 'console.log(new Date().toTimeString().match(/GMT([+-]\\d{4})/)[1])'; python3 -c 'import time; print(time.strftime("%z"))'`
  ).split("\n");
  expect(readings).toEqual(Array(3).fill(offset(new Date())));
});

test.skipIf(!inImage)("file mtimes read in the configured time zone", () => {
  // Midday UTC on a fixed date, so the local hour differs from UTC in any non-UTC zone.
  const moment = new Date("2026-07-15T12:00:00Z");
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(moment);
  const listed = asBox(
    `file=$(mktemp); touch -d @${moment.getTime() / 1000} "$file"; stat -c %y "$file"; ls -l --time-style=+%H:%M "$file" | awk '{print $6}'; rm "$file"`
  ).split("\n");
  expect(listed[0]).toEndWith(offset(moment));
  expect(listed[1]).toBe(local);
});

test.skipIf(!inImage)("the clock script resolves letter case and refuses unknown zones", () => {
  try {
    expect(applyZone("america/new_york").stdout).toContain("box clock set to America/New_York");
    expect(asBox("date +%z")).toBe(offset(new Date(), "America/New_York"));
    for (const bad of ["Not/AZone", "../../etc/passwd", "zone.tab", "+05:30"]) {
      const run = applyZone(bad);
      expect(run.status).toBe(0);
      expect(run.stderr).toContain("the box clock stays on UTC");
      expect(realpathSync("/etc/localtime")).toBe(realpathSync("/usr/share/zoneinfo/Etc/UTC"));
    }
    expect(spawnSync("/usr/local/bin/openteam-box-timezone", ["apply"]).status).toBe(2);
  } finally {
    expect(applyZone(zone!).status).toBe(0);
  }
});
