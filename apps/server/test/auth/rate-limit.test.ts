import { afterAll, describe, expect, test } from "bun:test";

process.env.OPENTEAM_AUTH_SECRET ??= "openteam-test-auth-secret-that-is-at-least-32-characters";
process.env.DATABASE_URL ??= "postgresql://openteam:openteam@127.0.0.1:1/openteam";

const { auth, authPrisma } = await import("../../src/auth");

afterAll(async () => {
  await authPrisma.$disconnect();
});

describe("Better Auth rate limiting", () => {
  test("limits username sign-in attempts in every environment", async () => {
    const attempt = () =>
      auth.handler(
        new Request("http://127.0.0.1:8787/api/auth/sign-in/username", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      );

    for (let index = 0; index < 3; index += 1) {
      expect((await attempt()).status).not.toBe(429);
    }
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-retry-after")).toBeTruthy();
  });
});
