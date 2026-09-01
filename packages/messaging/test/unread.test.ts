import { describe, expect, test } from "bun:test";
import { unreadBadgeCount, unreadChannelCount } from "../src/unread";

describe("unread badge counting", () => {
  test("uses one aggregate SQL query and returns its count", async () => {
    let queries = 0;
    const client = {
      $queryRaw: async () => {
        queries += 1;
        return [{ count: 42n }];
      },
    };

    await expect(unreadBadgeCount(client as never)).resolves.toBe(42);
    expect(queries).toBe(1);
  });

  test("counts one channel after its read sequence in SQL", async () => {
    let queries = 0;
    const client = {
      $queryRaw: async () => {
        queries += 1;
        return [{ count: 7n }];
      },
    };

    await expect(
      unreadChannelCount(client as never, "dec8b14f-402f-9e34-1ddd-a3ebb13c2329", 12n)
    ).resolves.toBe(7);
    expect(queries).toBe(1);
  });
});
