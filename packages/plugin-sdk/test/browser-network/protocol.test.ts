import { describe, expect, test } from "bun:test";
import { canonicalHost, dialTarget, publicAddress } from "../../src/browser-network/policy";
import { EventEmitter } from "node:events";
import { NetworkMux } from "../../src/browser-network/mux";
import { encodeFrame, FrameType, WINDOW, MAX_DATA } from "../../src/browser-network/protocol";

describe("browser network protocol and desktop policy", () => {
  test("public-address policy rejects private, metadata, special use and transition encodings", () => {
    for (const ip of ["127.0.0.1", "0.0.0.0", "10.1.2.3", "192.168.1.1", "172.16.1.1", "100.64.0.1", "169.254.169.254", "198.18.0.1", "192.0.2.1",
      "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fe80::1", "ff00::1", "2001:db8::1", "::ffff:127.0.0.1",
      "64:ff9b::a00:1", "2002:a00:1::1", "bad"])
      expect(publicAddress(ip), ip).toBe(false);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(publicAddress(ip), ip).toBe(true);
    for (const name of ["localhost", "a.localhost", "router.local", "0177.0.0.1", "2130706433", "0x7f000001", "foo bar", "::1%lo0"])
      expect(() => canonicalHost(name)).toThrow();
    expect(canonicalHost("EXAMPLE.COM.")).toBe("example.com");
  });
  test("mixed private DNS, blocked ports, and cancellation never dial", async () => {
    let dials = 0;
    const target = { host: "example.com", port: 443, epoch: "e" };
    const options = {
      publicOnly: true,
      lookup: async () => [{ address: "2606:4700:4700::1111", family: 6 }, { address: "1.1.1.1", family: 4 }, { address: "127.0.0.1", family: 4 }],
      dial: () => { dials++; throw Error("must not dial"); },
    } as any;
    await expect(dialTarget(target, new AbortController().signal, options)).rejects.toThrow("destination_blocked");
    await expect(dialTarget({ ...target, port: 22 }, new AbortController().signal, { ...options, ports: [80, 443] })).rejects.toThrow("port_blocked");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(dialTarget(target, cancelled.signal, options)).rejects.toThrow();
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

function fixture() {
  const frames: Uint8Array[] = [];
  let closed = false;
  const mux = new NetworkMux(
    {
      send: (bytes) => frames.push(bytes),
      close: () => {
        closed = true;
      },
      bufferedAmount: 0,
    },
    { control: () => {} }
  );
  return { mux, frames, closed: () => closed };
}
test("a slow consumer cannot receive beyond its advertised window", () => {
  const { mux, closed } = fixture();
  const stream = mux.open({ host: "example.com", port: 443, epoch: "e" });
  mux.receive(encodeFrame(FrameType.Ready, stream.id));
  mux.receive(encodeFrame(FrameType.Data, stream.id, new Uint8Array(MAX_DATA)));
  mux.receive(encodeFrame(FrameType.Data, stream.id, new Uint8Array(MAX_DATA)));
  expect(stream.readableLength).toBe(WINDOW);
  expect(closed()).toBe(false);
  mux.receive(encodeFrame(FrameType.Data, stream.id, new Uint8Array(1)));
  expect(closed()).toBe(true);
  expect(mux.streams.size).toBe(0);
});
test("unknown stream injection and oversized credits close the transport", () => {
  const a = fixture();
  a.mux.receive(encodeFrame(FrameType.Data, 999, new Uint8Array(1)));
  expect(a.closed()).toBe(true);
  const b = fixture(),
    stream = b.mux.open({ host: "example.com", port: 443, epoch: "e" });
  b.mux.receive(encodeFrame(FrameType.Ready, stream.id));
  const credit = new Uint8Array(4);
  new DataView(credit.buffer).setUint32(0, 1);
  b.mux.receive(encodeFrame(FrameType.Window, stream.id, credit));
  expect(b.closed()).toBe(true);
});
