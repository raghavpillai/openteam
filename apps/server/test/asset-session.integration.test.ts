import { expect, test } from "bun:test";

// An authenticated production-server fixture owns this disposable database.
// No owner credentials or existing attachment IDs are needed or logged.
const enabled = process.env.OPENTEAM_SWIFT_REAL_QA === "1";
test.skipIf(!enabled)("private attachment GET/HEAD/ranges require a valid owner session", async () => {
  const control = process.env.OPENTEAM_ASSET_QA_CONTROL_URL ?? "http://127.0.0.1:20022";
  const base = process.env.OPENTEAM_ASSET_QA_URL ?? "http://127.0.0.1:20020";
  const payload = "Disposable attachment authorization QA";
  const upload = await fetch(control + "/api/v0/assets", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileName: "private-qa.txt", mimeType: "text/plain", bytesBase64: Buffer.from(payload).toString("base64") }),
  });
  expect(upload.ok).toBe(true);
  const asset = await upload.json();
  expect(asset.assetId).toMatch(/^[a-f0-9]{64}$/);
  for (const prefix of ["/api/assets/", "/api/v0/assets/"]) {
    for (const method of ["GET", "HEAD"]) {
      const anonymous = await fetch(base + prefix + asset.assetId, { method });
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("content-range")).toBeNull();
      const invalid = await fetch(base + prefix + asset.assetId, { method, headers: { authorization: "Bearer invalid-qa-session", range: "bytes=0-4" } });
      expect(invalid.status).toBe(401);
    }
  }
  const authorized = await fetch(control + "/api/v0/assets/" + asset.assetId);
  expect(authorized.status).toBe(200);
  expect(await authorized.text()).toBe(payload);
  const head = await fetch(control + "/api/v0/assets/" + asset.assetId, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(payload)));
  expect(await head.text()).toBe("");
  // Use a separate disposable session so range headers reach the production
  // route directly, without changing the harness/app's own authentication.
  const config = await (await fetch(control + "/config")).json();
  const login = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: config.username, password: config.password }),
  });
  expect(login.ok).toBe(true);
  const token = login.headers.get("set-auth-token");
  expect(Boolean(token)).toBe(true);
  const headers = { authorization: `Bearer ${token}` };
  for (const prefix of ["/api/assets/", "/api/v0/assets/"]) {
    const range = await fetch(base + prefix + asset.assetId, { headers: { ...headers, range: "bytes=0-4" } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe(payload.slice(0, 5));
    expect(range.headers.get("content-range")).toBe(`bytes 0-4/${Buffer.byteLength(payload)}`);
  }
  const logout = await fetch(base + "/api/auth/sign-out", {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}",
  });
  expect(logout.status).toBe(200);
  expect((await fetch(base + "/api/v0/assets/" + asset.assetId, { headers })).status).toBe(401);
}, 30_000);
