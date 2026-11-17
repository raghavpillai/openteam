import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { UpdateQueueHttpChaos, until } from "./fixtures/update-queue-http-chaos";

const results: Array<Record<string, unknown>> = [];
async function scenario(name: string, run: (h: UpdateQueueHttpChaos) => Promise<void>) {
  const h = new UpdateQueueHttpChaos();
  const started = performance.now();
  try {
    await h.start();
    await run(h);
    results.push({
      name,
      passed: true,
      wallTimeMs: Math.round(performance.now() - started),
      ...h.summary(),
    });
  } catch (error) {
    results.push({ name, passed: false, error: String(error), ...h.summary() });
    throw error;
  } finally {
    await h.close();
  }
}
afterAll(() => {
  const directory = resolve(import.meta.dirname, "../../../output/update-queue-chaos");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, "http-chaos-results.json"),
    JSON.stringify(
      {
        simulatedInstallations: true,
        realLoopbackHttp: true,
        requestDeadlineMs: 100,
        cases: results.length,
        results,
      },
      null,
      2
    )
  );
});

test(
  "accepted POST with a lost response is observed on retry without a second job",
  () =>
    scenario("lost-accepted-post-response", async (h) => {
      h.faults.set("POST /api/v0/system/update", ["lost-post"]);
      const first = h.spawn("start");
      const failed = await first.done;
      expect(failed.code).toBe(0);
      expect(failed.result?.state?.status).toBe("error");
      expect(h.metrics.acceptedJobIds.size).toBe(1);
      const retry = h.spawn("retry");
      await until(() => h.snapshot()?.serverRequested, "retry adopted accepted job");
      h.complete();
      expect((await retry.done).result?.state?.status).toBe("complete");
      expect(h.metrics.postAttempts).toBe(1);
      expect(h.metrics.nativeJobs).toBe(1);
    }),
  15_000
);

test(
  "SIGKILL plus a real service restart preserves the host job and reconnects",
  () =>
    scenario("kill-queue-and-restart-service", async (h) => {
      const first = h.spawn("start");
      await until(
        () => h.metrics.postAttempts === 1 && h.snapshot()?.serverRequested,
        "host accepted request"
      );
      h.phase("backing-up");
      const jobId = h.updates.view().jobId;
      await h.kill(first);
      await h.stop();
      const resumed = h.spawn("resume");
      await new Promise((resolve) => setTimeout(resolve, 150));
      await h.restart();
      expect(h.updates.view().jobId).toBe(jobId);
      expect(h.updates.view().phase).toBe("backing-up");
      h.complete();
      expect((await resumed.done).result?.state?.status).toBe("complete");
      expect(h.metrics.postAttempts).toBe(1);
      expect(h.metrics.nativeJobs).toBe(1);
    }),
  15_000
);

test(
  "SIGKILL while native acceptance hangs does not dispatch a second native job",
  () =>
    scenario("kill-during-native-acceptance", async (h) => {
      h.autoDownload = false;
      h.acceptancePaused = true;
      const first = h.spawn("start");
      await until(() => h.metrics.postAttempts === 1, "host request");
      h.complete();
      await until(() => h.metrics.nativeJobs === 1, "native request is pending before progress");
      expect(h.native.status).toBe("available");
      await h.kill(first);
      const resumed = h.spawn("resume");
      await until(() => h.metrics.nativeRequests === 2, "reloaded queue joined the native request");
      expect(h.metrics.nativeJobs).toBe(1);
      h.releaseAcceptance();
      await until(() => h.native.status === "downloading", "native accepted request");
      h.finishDownload();
      expect((await resumed.done).result?.state?.status).toBe("complete");
      expect(h.metrics.nativeJobs).toBe(1);
      expect(h.metrics.postAttempts).toBe(1);
    }),
  15_000
);

test(
  "100 forced queue-process deaths during download do not resubmit maintenance",
  () =>
    scenario("100-process-deaths-during-download", async (h) => {
      h.autoDownload = false;
      let worker = h.spawn("start");
      await until(() => h.metrics.postAttempts === 1, "host request");
      h.complete();
      await until(() => h.native.status === "downloading", "native download");
      for (let crash = 0; crash < 100; crash++) {
        await h.kill(worker);
        const readsBefore = h.metrics.nativeStatusReads;
        worker = h.spawn("resume");
        await until(
          () => h.metrics.nativeStatusReads > readsBefore,
          "cold launch rechecked both host and native endpoints"
        );
        await until(
          () => h.snapshot()?.step === "desktop" && h.snapshot()?.serverComplete,
          "cold launch reverified host"
        );
      }
      h.finishDownload();
      expect((await worker.done).result?.state?.status).toBe("complete");
      expect(h.metrics.nativeRequests).toBe(1);
      expect(h.metrics.nativeJobs).toBe(1);
      expect(h.metrics.postAttempts).toBe(1);
    }),
  30_000
);

for (const fault of ["503", "malformed", "hang", "body-hang"] as const)
  test(
    `real HTTP ${fault} failures recover without premature desktop download`,
    () =>
      scenario(`http-${fault}`, async (h) => {
        h.faults.set("GET /api/v0/system/version", [fault, fault, fault]);
        const worker = h.spawn("start");
        await until(() => h.metrics.postAttempts === 1, "HTTP fault healed and host job submitted");
        expect(h.metrics.nativeJobs).toBe(0);
        h.complete();
        expect((await worker.done).result?.state?.status).toBe("complete");
        expect(h.metrics.injectedFaults).toBe(3);
        expect(h.metrics.postAttempts).toBe(1);
        expect(h.metrics.nativeJobs).toBe(1);
      }),
    15_000
  );

test(
  "authorization loss during restart prevents desktop progress until access returns",
  () =>
    scenario("authorization-loss", async (h) => {
      const worker = h.spawn("start");
      await until(() => h.snapshot()?.serverRequested, "host request acknowledged");
      h.authorized = false;
      h.complete();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(h.metrics.nativeJobs).toBe(0);
      h.authorized = true;
      expect((await worker.done).result?.state?.status).toBe("complete");
      expect(h.metrics.postAttempts).toBe(1);
    }),
  15_000
);

for (const failure of [
  "Database backup ran out of space",
  "Signature verification failed",
  "Rollback restored the previous release",
])
  test(
    `host failure: ${failure}`,
    () =>
      scenario(failure, async (h) => {
        const worker = h.spawn("start");
        await until(() => h.snapshot()?.serverRequested, "host request acknowledged");
        h.fail(failure);
        expect((await worker.done).result?.state).toMatchObject({
          status: "error",
          message: failure,
        });
        const reopened = h.spawn("resume");
        expect((await reopened.done).result?.state?.status).toBe("error");
        expect(h.metrics.postAttempts).toBe(1);
        expect(h.metrics.nativeJobs).toBe(0);
      }),
    15_000
  );

test(
  "a successful job report on the old release cannot advance to desktop",
  () =>
    scenario("old-version-after-restart", async (h) => {
      const worker = h.spawn("start");
      await until(() => h.snapshot()?.serverRequested, "host request acknowledged");
      h.complete("0.0.18");
      expect((await worker.done).result?.state?.status).toBe("error");
      expect(h.metrics.nativeJobs).toBe(0);
    }),
  15_000
);

test(
  "corrupt saved state fails closed without starting maintenance",
  () =>
    scenario("corrupt-checkpoint", async (h) => {
      writeFileSync(h.stateFile, '{"status":"running",');
      expect((await h.spawn("resume").done).result?.state).toBeNull();
      expect(h.metrics.postAttempts).toBe(0);
      expect(h.metrics.nativeJobs).toBe(0);
    }),
  15_000
);

test(
  "unwritable checkpoint storage leaves the in-memory queue functional",
  () =>
    scenario("unwritable-checkpoint-directory", async (h) => {
      chmodSync(h.cacheDirectory, 0o500);
      const worker = h.spawn("start");
      await until(() => h.metrics.postAttempts === 1, "host request despite unwritable cache");
      h.complete();
      const result = await worker.done;
      expect(result.result?.state?.status).toBe("complete");
      expect(result.result!.storageFailures).toBeGreaterThan(0);
      expect(h.metrics.postAttempts).toBe(1);
    }),
  15_000
);
