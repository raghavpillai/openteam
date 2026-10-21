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
      status: "running",
      subagent: { id: "sub", childBotId: "sub-bot", currentRunId: "child", status: "running" },
    },
    {
      id: "background-attempt",
      parentRunId: "parent",
      childRunId: "background",
      status: "running",
      subagent: { id: "bg", childBotId: "bg-bot", currentRunId: "background", status: "running" },
    },
  ];
  const calls: string[] = [];
  const shellStops: string[] = [];
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
    if (path.endsWith("/background-shells/stop")) {
      shellStops.push(id);
      return new Response('{"stopped":1}');
    }
    calls.push(id);
    return fetchImpl(id);
  });
  return {
    service,
    runs,
    children,
    calls,
    shellStops,
    events,
    inbox,
    setFetch: (f: typeof fetchImpl) => (fetchImpl = f),
    race: () => (queueRace = true),
  };
}
test("a stop leaves the parent's subagents running, since every Task runs in the background", async () => {
  const f = fixture();
  await Effect.runPromise(f.service.cancel("parent"));
  expect(f.runs.parent.status).toBe("cancelled");
  expect(f.calls).toEqual([]);
  expect(f.children.map((child: any) => child.status)).toEqual(["running", "running"]);
  f.runs.parent.status = "running";
  await Effect.runPromise(f.service.cancel("parent"));
  expect(f.calls).toEqual(["parent"]);
  expect(f.runs.child.status).toBe("running");
  // Their background shells keep running too; only StopSubagent ends a child's shells.
  expect(f.shellStops).toEqual([]);
});
test("HTTP failure on a running parent returns failure", async () => {
  const f = fixture();
  f.runs.parent.status = "running";
  f.setFetch(async () => new Response("unavailable", { status: 503 }));
  await expect(Effect.runPromise(f.service.cancel("parent"))).rejects.toThrow();
  expect(f.runs.parent.status).toBe("running");
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
