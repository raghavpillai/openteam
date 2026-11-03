import { describe, expect, test } from "bun:test";
import {
  decodeFrame,
  encodeFrame,
  FrameType,
  MAX_DATA,
  parseTarget,
} from "../../src/browser-network/protocol";
import { canonicalHost, dialTarget, publicAddress } from "../../src/browser-network/policy";
import { EventEmitter } from "node:events";

describe("browser network protocol and desktop policy", () => {
  test("binary frames preserve data and reject malformed lengths, flags, commands and IDs", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(1024));
    expect(decodeFrame(encodeFrame(FrameType.Data, 71, bytes)).payload).toEqual(bytes);
    for (const position of [0, 2, 8]) {
      const bad = encodeFrame(FrameType.Data, 1, bytes);
      bad[position] = 255;
      expect(() => decodeFrame(bad)).toThrow();
    }
    expect(() => decodeFrame(new Uint8Array(11))).toThrow();
    expect(() => encodeFrame(FrameType.Data, 0, bytes)).toThrow();
    expect(() => encodeFrame(FrameType.Control, 1, bytes)).toThrow();
    expect(() => encodeFrame(FrameType.Data, 1, new Uint8Array(MAX_DATA + 1))).toThrow();
    expect(() => encodeFrame(FrameType.Fin, 1, bytes)).toThrow();
    expect(() => encodeFrame(FrameType.Window, 1, bytes)).toThrow();
  });
  test("targets reject invalid ports, URL fragments and extra fields", () => {
    expect(parseTarget({ host: "example.com", port: 443, epoch: "epoch" })).toEqual({
      host: "example.com",
      port: 443,
      epoch: "epoch",
    });
    for (const host of ["a\0b", "user@host", "a/b", "x%25y", "a b"])
      expect(() => parseTarget({ host, port: 443, epoch: "e" })).toThrow();
    for (const port of [0, 65536, NaN, 443.1, "443"])
      expect(() => parseTarget({ host: "example.com", port, epoch: "e" })).toThrow();
    expect(() =>
      parseTarget({ host: "example.com", port: 443, epoch: "e", secret: "bad" })
    ).toThrow();
  });
  test("public-address policy rejects private, metadata, special use and transition encodings", () => {
    for (const ip of [
      "127.0.0.1",
      "0.0.0.0",
      "10.1.2.3",
      "192.168.1.1",
      "172.16.1.1",
      "100.64.0.1",
      "169.254.169.254",
      "198.18.0.1",
      "192.0.2.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fc00::1",
      "fe80::1",
      "ff00::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
      "64:ff9b::a00:1",
      "2002:a00:1::1",
      "bad",
    ])
      expect(publicAddress(ip), ip).toBe(false);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
      expect(publicAddress(ip), ip).toBe(true);
    for (const name of [
      "localhost",
      "a.localhost",
      "router.local",
      "0177.0.0.1",
      "2130706433",
      "0x7f000001",
      "foo bar",
      "::1%lo0",
    ])
      expect(() => canonicalHost(name)).toThrow();
    expect(canonicalHost("EXAMPLE.COM.")).toBe("example.com");
  });
  test("mixed private DNS, blocked ports, and cancellation never dial", async () => {
    let dials = 0;
    const options = {
      publicOnly: true,
      lookup: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      dial: () => {
        dials++;
        throw Error("must not dial");
      },
    } as any;
    await expect(
      dialTarget(
        { host: "example.com", port: 443, epoch: "e" },
        new AbortController().signal,
        options
      )
    ).rejects.toThrow("destination_blocked");
    await expect(
      dialTarget(
        { host: "example.com", port: 22, epoch: "e" },
        new AbortController().signal,
        options
      )
    ).rejects.toThrow("port_blocked");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      dialTarget({ host: "example.com", port: 443, epoch: "e" }, cancelled.signal, options)
    ).rejects.toThrow();
    expect(dials).toBe(0);
  });
  test("a DNS result arriving after cancellation is discarded", async () => {
    let release!: (value: unknown) => void,
      dials = 0;
    const controller = new AbortController();
    const result = dialTarget({ host: "example.com", port: 443, epoch: "e" }, controller.signal, {
      publicOnly: true,
      lookup: () => new Promise((r) => (release = r)),
      dial: () => {
        dials++;
        throw Error("late dial");
      },
    } as any);
    controller.abort();
    await expect(result).rejects.toThrow();
    release([{ address: "8.8.8.8", family: 4 }]);
    await Bun.sleep(10);
    expect(dials).toBe(0);
  });
  test("desktop DNS is pinned and TCP dialing never resolves the hostname a second time", async () => {
    let resolved = 0;
    let pinned = "";
    const socket = await dialTarget(
      { host: "example.com", port: 443, epoch: "e" },
      new AbortController().signal,
      {
        publicOnly: true,
        lookup: async () => {
          resolved++;
          return [{ address: "8.8.8.8", family: 4 }];
        },
        dial: (options: any) => {
          pinned = options.host;
          const value = new EventEmitter() as any;
          value.destroy = () => {};
          queueMicrotask(() => value.emit("connect"));
          return value;
        },
      } as any
    );
    expect(resolved).toBe(1);
    expect(pinned).toBe("8.8.8.8");
    socket.destroy();
  });
});
