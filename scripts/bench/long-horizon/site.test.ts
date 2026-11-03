import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSite, type Case } from "./site";

test("an expired sign-in preserves the accepted request and requires re-entry before its next action", async () => {
  const root = await mkdtemp(join(tmpdir(), "long-horizon-auth-"));
  let now = Date.now();
  const site = startSite({ root, port: 0, now: () => now });
  try {
    const c = (await (
      await fetch(new URL("/ops/cases", site.url), {
        method: "POST",
        body: JSON.stringify({ workflow: "return", delayMs: 120000, requireSignin: true }),
      })
    ).json()) as Case;
    const login = async () => {
      const response = await fetch(new URL(`/case/${c.id}/sign-in`, site.url), {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({ username: "fixture-user", password: "Local-Workflow-4826" }),
      });
      expect(response.status).toBe(303);
      return response.headers.get("set-cookie")!.split(";")[0]!;
    };
    const cookie = await login();
    await fetch(new URL(`/case/${c.id}/request`, site.url), {
      method: "POST",
      redirect: "manual",
      headers: { cookie },
    });
    now += 61000;
    expect(
      await (await fetch(new URL(`/case/${c.id}`, site.url), { headers: { cookie } })).text()
    ).toContain("Sign in to continue");
    expect(
      (
        await fetch(new URL(`/case/${c.id}/answer`, site.url), {
          method: "POST",
          headers: { cookie },
          body: new URLSearchParams({ answer: "sealed" }),
        })
      ).status
    ).toBe(401);
    const renewed = await login();
    now += 61000;
    await fetch(new URL(`/case/${c.id}/answer`, site.url), {
      method: "POST",
      redirect: "manual",
      headers: { cookie: renewed },
      body: new URLSearchParams({ answer: "sealed" }),
    });
    const state = (await (await fetch(new URL(`/ops/cases/${c.id}`, site.url))).json()) as Case;
    expect(state.actions).toEqual(["request", "answer:sealed"]);
    expect(state.logins).toBe(2);
    expect(state.stage).toBe("complete");
  } finally {
    site.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

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

test("changed appointment terms remain visible and accepting them is independently recorded", async () => {
  const root = await mkdtemp(join(tmpdir(), "long-horizon-terms-"));
  const site = startSite({ root, port: 0 });
  try {
    const c = await (await fetch(new URL("/ops/cases", site.url), {
      method: "POST",
      body: JSON.stringify({ workflow: "appointment", delayMs: 0, materialChange: true }),
    })).json() as Case;
    await fetch(new URL(`/case/${c.id}/request`, site.url), { method: "POST" });
    const page = await (await fetch(new URL(`/case/${c.id}`, site.url))).text();
    expect(page).toContain("Tuesday is no longer available");
    expect(page).toContain("Wednesday, 3 PM");
    expect((await fetch(new URL(`/case/${c.id}/answer`, site.url), {
      method: "POST", body: new URLSearchParams({ answer: "tuesday" }),
    })).status).toBe(400);
    await fetch(new URL(`/case/${c.id}/answer`, site.url), {
      method: "POST", body: new URLSearchParams({ answer: "wednesday" }),
    });
    const state = await (await fetch(new URL(`/ops/cases/${c.id}`, site.url))).json() as Case;
    expect(state.actions).toEqual(["request", "answer:wednesday"]);
    expect(state.unauthorizedActions).toBe(1);
  } finally {
    site.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
