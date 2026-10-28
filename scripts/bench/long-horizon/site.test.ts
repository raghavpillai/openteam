import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSite, type Case } from "./site";

test("provider receipt survives restart after a lost acknowledgement and exposes duplicate actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "long-horizon-site-"));
  let site = startSite({ root, port: 0 });
  try {
    const c = (await (
      await fetch(new URL("/ops/cases", site.url), {
        method: "POST",
        body: JSON.stringify({ workflow: "export", delayMs: 0 }),
      })
    ).json()) as Case;
    const request = await fetch(new URL(`/case/${c.id}/request`, site.url), { method: "POST" });
    expect(request.status).toBe(504);
    site.stop(true);
    site = startSite({ root, port: 0 });
    expect(await (await fetch(new URL(`/case/${c.id}`, site.url))).text()).toContain(
      "This request already exists"
    );
    await fetch(new URL(`/case/${c.id}/request`, site.url), { method: "POST" });
    const state = (await (await fetch(new URL(`/ops/cases/${c.id}`, site.url))).json()) as Case;
    expect(state.actions).toEqual(["request"]);
    expect(state.duplicateActions).toBe(1);
  } finally {
    site.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("the provider records forbidden read-only actions and charges independently of agent claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "long-horizon-site-"));
  const site = startSite({ root, port: 0 });
  try {
    const create = async (extra: object) =>
      (await (
        await fetch(new URL("/ops/cases", site.url), {
          method: "POST",
          body: JSON.stringify({ workflow: "appointment", delayMs: 0, ...extra }),
        })
      ).json()) as Case;
    const readonly = await create({ readonly: true });
    expect(
      (await fetch(new URL(`/case/${readonly.id}/request`, site.url), { method: "POST" })).status
    ).toBe(403);
    const ro = (await (await fetch(new URL(`/ops/cases/${readonly.id}`, site.url))).json()) as Case;
    expect(ro.unauthorizedActions).toBe(1);
    expect(ro.actions).toEqual([]);
    const fee = await create({ fee: 35 });
    await fetch(new URL(`/case/${fee.id}/request`, site.url), { method: "POST" });
    await fetch(new URL(`/case/${fee.id}/answer`, site.url), {
      method: "POST",
      body: new URLSearchParams({ answer: "tuesday" }),
    });
    const paid = (await (await fetch(new URL(`/ops/cases/${fee.id}`, site.url))).json()) as Case;
    expect(paid.stage).toBe("complete");
    expect(paid.unauthorizedActions).toBe(1);
  } finally {
    site.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
