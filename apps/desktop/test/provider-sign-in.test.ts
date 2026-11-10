import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { ProviderSignInCallback } from "../src/main/provider-sign-in";

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

test("hands the provider's localhost redirect back once the state matches", async () => {
  const port = await freePort();
  const callback = new ProviderSignInCallback();
  let opened = "";
  const result = await callback.capture(
    "https://auth.example.test/authorize?state=expected&client_id=app",
    `http://localhost:${port}/auth/callback`,
    async (url) => {
      opened = url;
      const forged = await fetch(`http://127.0.0.1:${port}/auth/callback?code=x&state=wrong`);
      expect(forged.status).toBe(404);
      const unrelated = await fetch(`http://127.0.0.1:${port}/elsewhere?code=x&state=expected`);
      expect(unrelated.status).toBe(404);
      const response = await fetch(
        `http://127.0.0.1:${port}/auth/callback?code=abc&state=expected`
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("You're signed in");
    }
  );
  expect(opened).toBe("https://auth.example.test/authorize?state=expected&client_id=app");
  expect(result).toEqual({
    status: "captured",
    callbackUrl: `http://localhost:${port}/auth/callback?code=abc&state=expected`,
  });
  // The listener closes after one redirect.
  await expect(fetch(`http://127.0.0.1:${port}/auth/callback`)).rejects.toThrow();
});

test("falls back to pasting, with the page open, when another app holds the redirect port", async () => {
  const blocker = createServer();
  const port = await new Promise<number>((resolve) =>
    blocker.listen(0, "127.0.0.1", () => resolve((blocker.address() as { port: number }).port))
  );
  try {
    let opened = false;
    const result = await new ProviderSignInCallback().capture(
      "https://auth.example.test/authorize?state=s",
      `http://localhost:${port}/callback`,
      async () => {
        opened = true;
      }
    );
    expect(result.status).toBe("unavailable");
    expect(opened).toBe(true);
  } finally {
    blocker.close();
  }
});

test("cancelling stops waiting for the browser", async () => {
  const port = await freePort();
  const callback = new ProviderSignInCallback();
  const result = callback.capture(
    "https://auth.example.test/authorize?state=s",
    `http://localhost:${port}/callback`,
    async () => {
      callback.cancel();
    }
  );
  expect(await result).toEqual({ status: "cancelled" });
});

test("only accepts HTTPS sign-in pages and loopback redirects", async () => {
  const callback = new ProviderSignInCallback();
  const opened: string[] = [];
  const open = async (url: string) => {
    opened.push(url);
  };
  expect(
    (await callback.capture("http://auth.example.test/a", "http://localhost:4545/cb", open)).status
  ).toBe("unavailable");
  expect(
    (await callback.capture("https://auth.example.test/a", "http://example.test:4545/cb", open))
      .status
  ).toBe("unavailable");
  expect(
    (await callback.capture("https://auth.example.test/a", "http://localhost:80/cb", open)).status
  ).toBe("unavailable");
  expect(opened).toEqual([]);
});
