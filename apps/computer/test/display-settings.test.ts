import { expect, test } from "bun:test";
import { ComputerDisplaySettings } from "../src/display-settings";

test("cold desktops require validated dimensions and concurrent startup reads coalesce", async () => {
  let calls = 0;
  const settings = new ComputerDisplaySettings(async () => {
    calls++;
    return { width: 1920, height: 1080 };
  });
  expect(await Promise.all(Array.from({ length: 3 }, () => settings.get()))).toEqual(
    Array(3).fill({ width: 1920, height: 1080 })
  );
  expect(calls).toBe(1);
  for (const value of [null, {}, { width: 1, height: 1080 }, { width: 1920, height: NaN }])
    await expect(new ComputerDisplaySettings(async () => value).get()).rejects.toThrow("Invalid");
  await expect(
    new ComputerDisplaySettings(async () => {
      throw Error("offline");
    }).get()
  ).rejects.toThrow("offline");
});

test("chaos: expired display settings do not block screen controls behind a frozen server", async () => {
  let now = 0,
    calls = 0;
  let release!: (value: unknown) => void;
  const frozen = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const settings = new ComputerDisplaySettings(
    async () => {
      calls++;
      return calls === 1 ? { width: 1920, height: 1080 } : frozen;
    },
    () => now
  );
  await settings.get();
  now = 30_001;
  const reads = Promise.all(Array.from({ length: 20 }, () => settings.get()));
  const outcome = await Promise.race([reads, Bun.sleep(100).then(() => "blocked")]);
  expect(outcome).toEqual(Array(20).fill({ width: 1920, height: 1080 }));
  expect(calls).toBe(2);
  release({ width: 2560, height: 1440 });
  await Bun.sleep(0);
  expect(await settings.get()).toEqual({ width: 2560, height: 1440 });
});

test("chaos: failed or invalid background refresh retains accepted settings with bounded retries", async () => {
  let now = 0,
    calls = 0;
  const settings = new ComputerDisplaySettings(
    async () => {
      calls++;
      if (calls === 1) return { width: 1920, height: 1080 };
      if (calls === 2) throw Error("injected server outage");
      if (calls === 3) return { width: -1, height: 1080 };
      return { width: 2560, height: 1440 };
    },
    () => now
  );
  await settings.get();
  for (const attempt of [2, 3, 4]) {
    now = attempt === 2 ? 30_001 : now + 5001;
    await settings.get();
    await Bun.sleep(0);
    expect(calls).toBe(attempt);
    const result = await settings.get();
    expect(result.width).toBe(attempt === 4 ? 2560 : 1920);
    expect(calls).toBe(attempt);
  }
});
