import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { ScreenBroker } from "../src/screen-broker";
import type { ScreenSession } from "../src/screen/types";

test.skipIf(process.env.OPENTEAM_CUA_DESKTOP_TESTS !== "1")(
  "live computer video produces continuous JPEGs and releases encoders on cancel",
  async () => {
    const home = await mkdtemp("/tmp/cua-stream-");
    const broker = new ScreenBroker(home);
    try {
      await broker.ensure("stream-probe", "/workspace");
      const session = (broker as unknown as { sessions: Map<string, ScreenSession> }).sessions.get(
        "stream-probe"
      )!;
      const original = session.processes.length;
      const abort = new AbortController();
      const body = await broker.stream("stream-probe", "/workspace", abort.signal);
      const reader = body.getReader();
      let wire = Buffer.alloc(0);
      const start = Date.now();
      while ((wire.toString("latin1").match(/Content-type: image\/jpeg/gi)?.length ?? 0) < 10) {
        const next = await reader.read();
        if (next.done) throw new Error("video ended early");
        wire = Buffer.concat([wire, next.value]);
        if (Date.now() - start > 8_000) throw new Error("video did not stream continuously");
      }
      expect(wire.includes(Buffer.from([0xff, 0xd8]))).toBe(true);
      expect(Date.now() - start).toBeLessThan(8_000);
      expect(session.processes.length).toBe(original + 1);
      await reader.cancel();
      for (let i = 0; i < 100 && session.processes.length !== original; i++) await Bun.sleep(20);
      expect(session.processes.length).toBe(original);
      const readers = await Promise.all(
        [0, 1, 2].map(async () =>
          (await broker.stream("stream-probe", "/workspace", abort.signal)).getReader()
        )
      );
      await expect(broker.stream("stream-probe", "/workspace", abort.signal)).rejects.toThrow(
        "Too many"
      );
      abort.abort();
      await Promise.allSettled(readers.map((r) => r.cancel()));
      for (let i = 0; i < 100 && session.processes.length !== original; i++) await Bun.sleep(20);
      expect(session.processes.length).toBe(original);
    } finally {
      await broker.destroy("stream-probe");
      await rm(home, { recursive: true, force: true });
    }
  },
  40_000
);
