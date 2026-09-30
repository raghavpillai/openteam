import { test, expect } from "bun:test";
import { Effect } from "effect";
import { RunService } from "../src/services/run-service";
function fixture() {
  const runs: any = {
    parent: { id: "parent", status: "queued" },
    child: { id: "child", status: "running" },
    background: { id: "background", status: "running" },
  };
  const children: any[] = [
    {
      id: "attempt",
      parentRunId: "parent",
      childRunId: "child",
      runInBackground: false,
      status: "running",
      subagent: { id: "sub", currentRunId: "child", status: "running" },
    },
    {
      id: "background-attempt",
      parentRunId: "parent",
      childRunId: "background",
      runInBackground: true,
      status: "running",
      subagent: { id: "bg", currentRunId: "background", status: "running" },
    },
  ];
  const calls: string[] = [];
  const events: any[] = [];
  const inbox: any[] = [];
  let queueRace = false;
  const matches = (row: any, where: any) =>
    Object.entries(where).every(([key, value]: any) =>
      key === "status" && typeof value === "object"
        ? value.in.includes(row[key])
        : row[key] === value
    );
  const db: any = {
    run: {
      findUnique: async ({ where }: any) => (runs[where.id] ? { ...runs[where.id] } : null),
      update: async ({ where, data }: any) => Object.assign(runs[where.id], data),
      updateMany: async ({ where, data }: any) => {
        if (queueRace && where.id === "parent" && where.status === "queued") {
          queueRace = false;
          runs.parent.status = "running";
          return { count: 0 };
        }
        const r = runs[where.id];
        if (!r || !matches(r, where)) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
    },
    subagentAttempt: {
      findMany: async ({ where }: any) =>
        children
          .filter((x) => matches(x, where))
          .map((x) => ({ ...x, subagent: { ...x.subagent } })),
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const c of children)
          if (matches(c, where)) {
            Object.assign(c, data);
            count++;
          }
        return { count };
      },
    },
    subagent: {
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const c of children)
          if (matches(c.subagent, where)) {
            Object.assign(c.subagent, data);
            count++;
          }
        return { count };
      },
    },
    inboxEvent: {
      updateMany: async (x: any) => {
        inbox.push(x);
        return { count: 1 };
      },
    },
    approval: { updateMany: async () => ({ count: 1 }) },
    event: { create: async ({ data }: any) => events.push(data) },
  };
  db.$transaction = async (fn: any) => fn(db);
  let fetchImpl = async (_id: string) => new Response("{}", { status: 200 });
  const service = new RunService(db, async (path: string) => {
    const id = path.split("/")[3]!;
    calls.push(id);
    return fetchImpl(id);
  });
  return {
    service,
    runs,
    children,
    calls,
    events,
    inbox,
    setFetch: (f: typeof fetchImpl) => (fetchImpl = f),
    race: () => (queueRace = true),
  };
}
test("HTTP failure leaves child active and returns failure", async () => {
  const f = fixture();
  f.setFetch(async () => new Response("unavailable", { status: 503 }));
  await expect(Effect.runPromise(f.service.cancel("parent"))).rejects.toThrow();
  expect(f.runs.parent.status).toBe("cancelled");
  expect(f.runs.child.status).toBe("running");
  expect(f.children[0].status).toBe("running");
  expect(f.children[0].subagent.status).toBe("running");
});
test("retrying cancelled parent retries failed child and preserves background worker", async () => {
  const f = fixture();
  f.setFetch(async () => {
    throw new Error("transport timeout");
  });
  await Effect.runPromise(f.service.cancel("parent")).catch(() => {});
  f.setFetch(async () => new Response("{}"));
  await Effect.runPromise(f.service.cancel("parent"));
  expect(f.calls).toEqual(["child", "child"]);
  expect(f.runs.child.status).toBe("cancelled");
  expect(f.children[0].status).toBe("stopped");
  expect(f.children[1].status).toBe("running");
  expect(f.runs.background.status).toBe("running");
});
test("queued-to-running race dispatches cancellation instead of reporting queued success", async () => {
  const f = fixture();
  f.children.length = 0;
  f.race();
  await Effect.runPromise(f.service.cancel("parent"));
  expect(f.calls).toEqual(["parent"]);
  expect(f.runs.parent.status).toBe("cancelled");
  expect(f.inbox).toHaveLength(0);
});
test("child stays active until acknowledgement", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  f.setFetch(async () => {
    await gate;
    return new Response("{}");
  });
  const pending = Effect.runPromise(f.service.cancel("parent"));
  await new Promise((r) => setTimeout(r, 10));
  const before = f.children[0].status;
  release();
  await pending;
  expect(before).toBe("running");
  expect(f.children[0].status).toBe("stopped");
});
test("completion during network failure is accepted without changing completed run", async () => {
  const f = fixture();
  f.setFetch(async () => {
    f.runs.child.status = "completed";
    throw new Error("socket closed");
  });
  await Effect.runPromise(f.service.cancel("parent"));
  expect(f.runs.child.status).toBe("completed");
  expect(f.children[0].status).toBe("stopped");
});
test("new child attempt is not overwritten by an old acknowledgement", async () => {
  const f = fixture();
  f.setFetch(async () => {
    f.children[0].subagent.currentRunId = "new-run";
    return new Response("{}");
  });
  await Effect.runPromise(f.service.cancel("parent"));
  expect(f.children[0].subagent.status).toBe("running");
  expect(f.children[0].subagent.currentRunId).toBe("new-run");
});
test("all independent children attempted when one fails", async () => {
  const f = fixture();
  f.runs.second = { id: "second", status: "running" };
  f.children.push({
    id: "second-attempt",
    parentRunId: "parent",
    childRunId: "second",
    runInBackground: false,
    status: "running",
    subagent: { id: "second-sub", currentRunId: "second", status: "running" },
  });
  f.setFetch(async (id) => new Response("{}", { status: id === "child" ? 503 : 200 }));
  await expect(Effect.runPromise(f.service.cancel("parent"))).rejects.toThrow();
  expect(f.calls.sort()).toEqual(["child", "second"]);
  expect(f.runs.child.status).toBe("running");
  expect(f.runs.second.status).toBe("cancelled");
  expect(f.children[2].status).toBe("stopped");
});
