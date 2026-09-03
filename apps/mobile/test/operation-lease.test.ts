import { describe, expect, test } from "bun:test";
import { type OperationLease, operationLeaseIsCurrent } from "@openteam/client-core";

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

describe("mobile async operation origin leases", () => {
  test("drops delayed create, send, and mutation results after switching servers", async () => {
    const serverA = { name: "server-a" };
    const serverB = { name: "server-b" };
    let activeClient = serverA;
    let activeEpoch = 1;
    let visibleState = "server-a";
    const lease: OperationLease<typeof serverA> = { client: serverA, epoch: activeEpoch };
    const create = deferred<string>();
    const send = deferred<string>();
    const mutation = deferred<string>();
    const commitWhenCurrent = async (result: Promise<string>) => {
      const value = await result;
      if (operationLeaseIsCurrent(activeClient, activeEpoch, lease)) visibleState = value;
    };
    const pending = [
      commitWhenCurrent(create.promise),
      commitWhenCurrent(send.promise),
      commitWhenCurrent(mutation.promise),
    ];

    activeClient = serverB;
    activeEpoch = 2;
    visibleState = "server-b";
    create.resolve("stale-create");
    send.resolve("stale-send");
    mutation.resolve("stale-mutation");
    await Promise.all(pending);

    expect(visibleState).toBe("server-b");
    expect(operationLeaseIsCurrent(serverB, activeEpoch, lease)).toBe(false);
  });

  test("accepts a result only while both client identity and epoch remain current", () => {
    const client = { name: "server" };
    const lease = { client, epoch: 4 };

    expect(operationLeaseIsCurrent(client, 4, lease)).toBe(true);
    expect(operationLeaseIsCurrent(client, 5, lease)).toBe(false);
    expect(operationLeaseIsCurrent({ name: "server" }, 4, lease)).toBe(false);
  });

  test("wires captured leases through provider reconciliation and mutation paths", async () => {
    const source = await Bun.file(
      new URL("../src/state/openteam-context.tsx", import.meta.url)
    ).text();

    expect(source).toContain("operationLeaseIsCurrent(activeClientRef.current");
    expect(source).toContain(
      "const client = readyClient === candidateClient ? candidateClient : null"
    );
    expect(source.indexOf("setReadyClient(null)")).toBeLessThan(
      source.indexOf("setReadyClient(candidateClient)")
    );
    expect(source).toContain("beginClientRetirement(client);");
    expect(source).toContain("createDurableSendController");
    expect(source).toContain("clientId: record.nonce");
    expect(source).toContain("client.messageDeliveryStatus(record.target.channelId, record.nonce)");
    expect(source).toContain("await sendController.enqueue");
    expect(source).toContain("acceptRichMessageMutation(result.message, operationClient, epoch)");
    expect(source).toContain("await operationClient.setRoutineEnabled(routine, enabled)");
    expect(source).toContain("await operationClient.screenAction(botId, input)");
    expect(
      source.match(/operationIsCurrent\(operationClient, epoch\)/g)?.length ?? 0
    ).toBeGreaterThan(20);
    expect(source).not.toContain("acceptRemoteBootstrap(await client.bootstrap())");
  });
});
