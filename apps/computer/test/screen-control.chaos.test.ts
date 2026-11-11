import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenBroker } from "../src/screen-broker";
import type { ScreenSession } from "../src/screen/types";

const seedBase = Number(process.env.CONTROL_CHAOS_SEED ?? 1);
if (!Number.isSafeInteger(seedBase) || seedBase < 1 || seedBase > 0xffffff00)
  throw new Error("CONTROL_CHAOS_SEED must be a positive 32-bit seed");
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const home = async () => {
  const p = await mkdtemp(join(tmpdir(), "control-chaos-"));
  homes.push(p);
  return p;
};
const open = (path: string) => {
  const broker = new ScreenBroker(path);
  Object.assign(broker, {
    startSession: async (s: ScreenSession) => {
      s.state = "ready";
      s.lastHealthCheckAt = Date.now();
    },
  });
  return broker;
};
const sameViewer = (control: { id: string } | null, id: string) => control?.id === id;
function random(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

test("chaos: seeded transfers, duplicate requests, stale cleanup, disconnects and restarts", async () => {
  let operations = 0,
    restarts = 0;
  for (let seed = seedBase; seed < seedBase + 30; seed++) {
    const rng = random(seed),
      path = await home();
    let broker = open(path);
    let expected: { id: string; generation: number } | null = null,
      sequence = 0;
    const history: Array<{ id: string; generation: number }> = [];
    for (let step = 0; step < 150; step++) {
      const choice = Math.floor(rng() * 6),
        id = ["desktop-a", "desktop-b", "ios"][Math.floor(rng() * 3)]!;
      if (choice === 0 || choice === 1) {
        const next = await broker.takeover("bot", "/workspace", true, {
          controlId: id,
          force: true,
        });
        if (!sameViewer(expected, id)) sequence++;
        expected = { id, generation: sequence };
        history.push({ ...expected });
        expect(next.controlSession, `seed ${seed} step ${step}`).toEqual(expected);
      } else if (choice === 2) {
        const stale = history[Math.floor(rng() * history.length)] ?? { id, generation: 0 };
        const status = await broker.takeover("bot", "/workspace", false, {
          controlId: stale.id,
          generation: stale.generation,
        });
        if (expected?.id === stale.id && expected?.generation === stale.generation) {
          expected = null;
          sequence++;
        }
        expect(status.controlSession, `seed ${seed} step ${step}`).toEqual(expected);
      } else if (choice === 3) {
        broker = open(path);
        restarts++;
      } else if (choice === 4) {
        // A network partition issues no control operation. Observation and reconnection must not renew or acquire.
        await broker.status("bot", "/workspace");
        await broker.status("bot", "/workspace");
      } else {
        await broker.takeover("bot", "/workspace", true, { renew: true });
        // Legacy renewal cannot acquire a persistent session.
      }
      const actual = await broker.status("bot", "/workspace");
      expect(actual.controlSession, `seed ${seed} step ${step}`).toEqual(expected);
      for (const viewer of ["desktop-a", "desktop-b", "ios"]) {
        expect(broker.viewerMayInput("bot", { controlId: viewer, generation: sequence })).toBe(
          expected?.id === viewer
        );
      }
      operations++;
    }
  }
  console.log(
    JSON.stringify({
      experiment: "seeded-control-chaos",
      firstSeed: seedBase,
      seeds: 30,
      operations,
      restarts,
    })
  );
}, 30000);

class Worker {
  child: Bun.Subprocess<"pipe", "pipe", "inherit">;
  private next = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private events = new Map<string, (v: any) => void>();
  constructor(path: string) {
    this.child = Bun.spawn(
      [
        process.execPath,
        new URL("./fixtures/control-chaos-worker.ts", import.meta.url).pathname,
        path,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "inherit" }
    );
    const child = this.child;
    void (async () => {
      let buffer = "";
      const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
      while (true) {
        const { done, value: text } = await reader.read();
        if (done) {
          reader.releaseLock();
          break;
        }
        buffer += text;
        let n: number;
        while ((n = buffer.indexOf("\n")) !== -1) {
          const result = JSON.parse(buffer.slice(0, n));
          buffer = buffer.slice(n + 1);
          if (result.event) {
            this.events.get(result.event)?.(result);
            this.events.delete(result.event);
          } else {
            const pending = this.pending.get(result.id);
            this.pending.delete(result.id);
            if (result.error) pending?.reject(Error(result.error));
            else pending?.resolve(result);
          }
        }
      }
    })();
    void this.child.exited.then(() => {
      for (const p of this.pending.values()) p.reject(Error("worker terminated"));
      this.pending.clear();
    });
  }
  send(request: Record<string, unknown>) {
    const id = ++this.next;
    const promise = new Promise<any>((resolve, reject) =>
      this.pending.set(id, { resolve, reject })
    );
    this.child.stdin.write(JSON.stringify({ ...request, id }) + "\n");
    return promise;
  }
  event(name: string) {
    return new Promise<any>((resolve) => this.events.set(name, resolve));
  }
  async kill() {
    this.child.kill("SIGKILL");
    await this.child.exited;
  }
}

test("chaos: actual SIGKILL before commit and after commit preserves an atomic owner", async () => {
  const path = await home();
  let worker = new Worker(path);
  let generation = 0;
  try {
    for (let round = 0; round < 6; round++) {
      const owner = round % 2 ? "ios" : "desktop";
      const acknowledged = await worker.send({
        op: "take",
        active: true,
        control: { controlId: owner, force: true },
      });
      generation = acknowledged.control.generation;
      const prepared = worker.event("prepared");
      const interrupted = worker.send({
        op: "take",
        active: true,
        control: { controlId: owner + "-next", force: true },
        preparePause: true,
      });
      void interrupted.catch(() => {});
      await prepared;
      await worker.kill();
      worker = new Worker(path);
      expect((await worker.send({ op: "status" })).control).toEqual({ id: owner, generation });
      const committed = worker.event("committed");
      const ambiguous = worker.send({
        op: "take",
        active: true,
        control: { controlId: owner + "-committed", force: true },
        commitPause: true,
      });
      void ambiguous.catch(() => {});
      const saved = await committed;
      await worker.kill();
      worker = new Worker(path);
      expect((await worker.send({ op: "status" })).control).toEqual(saved.control);
      // A delayed release from the pre-crash owner cannot clear the committed transfer.
      const stale = await worker.send({
        op: "take",
        active: false,
        control: { controlId: owner, generation },
      });
      expect(stale.control).toEqual(saved.control);
    }
    console.log(
      JSON.stringify({
        experiment: "process-kill-chaos",
        sigkills: 12,
        commitBoundaries: ["before-persist", "after-persist-before-ack"],
      })
    );
  } finally {
    await worker.kill();
  }
}, 30000);
