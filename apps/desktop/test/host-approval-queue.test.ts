import { describe, expect, test } from "bun:test";
import { HostApprovalQueue } from "../src/main/host-approval-queue";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("host approval queue", () => {
  test("serializes native dialogs in request order", async () => {
    const approvals = new HostApprovalQueue(1, 2);
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const opened: string[] = [];

    const firstResult = approvals.request(() => {
      opened.push("first");
      return first.promise;
    });
    const secondResult = approvals.request(() => {
      opened.push("second");
      return second.promise;
    });

    expect(opened).toEqual(["first"]);
    expect(approvals.snapshot()).toEqual({ active: 1, queued: 1 });
    first.resolve(true);
    await expect(firstResult).resolves.toBe(true);
    expect(opened).toEqual(["first", "second"]);

    second.resolve(false);
    await expect(secondResult).resolves.toBe(false);
    expect(approvals.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  test("rejects bursts beyond the bounded waiting queue", async () => {
    const approvals = new HostApprovalQueue(1, 1);
    const active = deferred<boolean>();
    const first = approvals.request(() => active.promise);
    const queued = approvals.request(async () => true);

    expect(approvals.snapshot()).toEqual({ active: 1, queued: 1 });
    await expect(approvals.request(async () => true)).rejects.toThrow(
      "Host approval queue is full (1 waiting requests)"
    );

    active.resolve(true);
    await expect(first).resolves.toBe(true);
    await expect(queued).resolves.toBe(true);
  });

  test("can disable waiting without disabling the active dialog slot", async () => {
    const approvals = new HostApprovalQueue(1, 0);
    const active = deferred<boolean>();
    const first = approvals.request(() => active.promise);

    expect(approvals.snapshot()).toEqual({ active: 1, queued: 0 });
    await expect(approvals.request(async () => true)).rejects.toThrow("queue is full");
    active.resolve(true);
    await expect(first).resolves.toBe(true);
  });

  test("removes disconnected requests before opening their dialog", async () => {
    const approvals = new HostApprovalQueue(1, 1);
    const active = deferred<boolean>();
    const first = approvals.request(() => active.promise);
    const controller = new AbortController();
    let opened = false;
    const queued = approvals.request(async () => {
      opened = true;
      return true;
    }, controller.signal);

    controller.abort();
    await expect(queued).rejects.toThrow("Host approval was cancelled");
    expect(approvals.snapshot()).toEqual({ active: 1, queued: 0 });
    active.resolve(true);
    await expect(first).resolves.toBe(true);
    expect(opened).toBe(false);
  });

  test("does not release the dialog slot until an aborted active dialog closes", async () => {
    const approvals = new HostApprovalQueue(1, 1);
    const controller = new AbortController();
    const active = deferred<boolean>();
    const first = approvals.request(() => active.promise, controller.signal);
    let secondOpened = false;
    const second = approvals.request(async () => {
      secondOpened = true;
      return true;
    });

    controller.abort();
    expect(secondOpened).toBe(false);
    expect(approvals.snapshot()).toEqual({ active: 1, queued: 1 });
    active.resolve(false);
    await expect(first).rejects.toThrow("Host approval was cancelled");
    await expect(second).resolves.toBe(true);
    expect(secondOpened).toBe(true);
  });
});
