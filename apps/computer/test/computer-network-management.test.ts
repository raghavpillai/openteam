import { expect, test } from "bun:test";
import { startManagementDiscovery } from "../src/computer-network-management";

test("management discovery boots without a server, starts once available, and refreshes changed IPs", async () => {
  let addresses: string[] = [],
    starts = 0,
    fail = false;
  const applied: string[][] = [];
  const watch = startManagementDiscovery(
    "http://future-server:8787",
    () => {
      starts++;
    },
    {
      intervalMs: 5,
      resolve: async () => {
        if (fail) throw new Error("DNS unavailable");
        return addresses;
      },
      apply: async (value) => {
        applied.push(value);
      },
    }
  );
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(5);
    expect(check()).toBe(true);
  };
  try {
    await Bun.sleep(15);
    expect(starts).toBe(0);
    expect(applied).toEqual([]);
    addresses = ["10.0.0.2"];
    await until(() => starts === 1);
    fail = true;
    await Bun.sleep(15);
    expect(applied).toEqual([["10.0.0.2"]]);
    fail = false;
    addresses = ["10.0.0.3", "10.0.0.3", "invalid"];
    await until(() => applied.length === 2);
    expect(applied[1]).toEqual(["10.0.0.3"]);
    expect(starts).toBe(1);
  } finally {
    watch.stop();
  }
});

test("failed route publication cannot start the relay, and shutdown discards late DNS", async () => {
  let starts = 0,
    apply = 0,
    release!: (addresses: string[]) => void;
  const watch = startManagementDiscovery(
    "http://future-server:8787",
    () => {
      starts++;
    },
    {
      intervalMs: 5,
      resolve: async () => ["10.0.0.2"],
      apply: async () => {
        apply++;
        throw new Error("Kernel update failed");
      },
    }
  );
  await Bun.sleep(25);
  watch.stop();
  expect(apply).toBeGreaterThan(0);
  expect(starts).toBe(0);
  const late = startManagementDiscovery(
    "http://future-server:8787",
    () => {
      starts++;
    },
    {
      intervalMs: 5,
      resolve: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      apply: async () => {
        apply++;
      },
    }
  );
  late.stop();
  const before = apply;
  release(["10.0.0.9"]);
  await Bun.sleep(5);
  expect(starts).toBe(0);
  expect(apply).toBe(before);
});
