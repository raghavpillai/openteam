import { expect, test } from "bun:test";
import type { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { createPublicFaviconFetch, publicFaviconLookup } from "../src/main/public-favicon-fetch";

const resolver = (answers: { address: string; family: number }[]) =>
  (async () => answers) as typeof lookup;
const resolved = (answers: { address: string; family: number }[]) => new Promise((resolve, reject) => {
  publicFaviconLookup(resolver(answers))("example.com", { all: true }, (error, result) => {
    if (error) reject(error);
    else resolve(result);
  });
});

for (const address of ["127.0.0.1", "192.168.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1", "64:ff9b::7f00:1", "2002:7f00:1::"]) {
  test(`DNS refuses ${address}, including mixed public/private answers`, async () => {
    const privateAnswer = { address, family: address.includes(":") ? 6 : 4 };
    await expect(resolved([privateAnswer])).rejects.toThrow("not public");
    await expect(resolved([{ address: "8.8.8.8", family: 4 }, privateAnswer])).rejects.toThrow("not public");
  });
}

test("socket lookup returns validated addresses directly and revalidates the next connection", async () => {
  let calls = 0;
  const pinned = [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
  const resolve = (async () => ++calls === 1 ? pinned : [{ address: "127.0.0.1", family: 4 }]) as typeof lookup;
  const lookupSocket = publicFaviconLookup(resolve);
  const call = () => new Promise((done, reject) => {
    lookupSocket("rebind.example.com", { all: true }, (error, answers) => error ? reject(error) : done(answers));
  });
  expect(await call()).toEqual(pinned);
  expect(calls).toBe(1);
  await expect(call()).rejects.toThrow("not public");
  expect(calls).toBe(2);
});

test("real HTTP transport never connects to a public hostname resolving to loopback", async () => {
  let connections = 0;
  const server = createServer((_request, response) => { response.end("private"); });
  server.on("connection", () => { connections++; });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const fetch = createPublicFaviconFetch(resolver([{ address: "127.0.0.1", family: 4 }]));
    await expect(fetch(`http://public.example.com:${address.port}/private`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow("not public");
    expect(connections).toBe(0);
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});
