import { expect, test } from "bun:test";
import { Socket } from "node:net";
import { dialTarget } from "../../src/browser-network/policy";
const target = { host: "example.com", port: 443, epoch: "e" };
const addresses = [
  { address: "2606:4700:4700::1111", family: 6 },
  { address: "2001:4860:4860::8888", family: 6 },
  { address: "1.1.1.1", family: 4 },
];

test("private answers reject the entire set before racing any public address", async () => {
  let dials = 0;
  await expect(
    dialTarget(target, new AbortController().signal, {
      publicOnly: true,
      lookup: (async () => [...addresses, { address: "192.168.1.1", family: 4 }]) as any,
      dial: (() => {
        dials++;
        return new Socket();
      }) as any,
    })
  ).rejects.toThrow("destination_blocked");
  expect(dials).toBe(0);
});
