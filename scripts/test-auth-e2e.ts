import { strict as assert } from "node:assert";
import { auth, authPrisma } from "../apps/server/src/auth";
import { setOwnerCredentials } from "../apps/server/src/owner-credentials";

const authRequest = (path: string, init?: RequestInit) =>
  auth.handler(new Request(`http://127.0.0.1:8787/api/auth${path}`, init));

const signIn = (username: string, password: string) =>
  authRequest("/sign-in/username", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, rememberMe: true }),
  });

try {
  await setOwnerCredentials({
    operation: "setup",
    username: "OpenBot.Owner",
    password: "first test password",
  });

  const signup = await authRequest("/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "intruder",
      email: "intruder@example.test",
      password: "intruder password",
    }),
  });
  assert.equal(signup.status, 404, "public signup must be disabled");

  const emailLogin = await authRequest("/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "openbot.owner@openbot.invalid",
      password: "first test password",
    }),
  });
  assert.equal(emailLogin.status, 404, "email sign-in must be disabled");

  const firstLogin = await signIn("OPENBOT.OWNER", "first test password");
  assert.equal(firstLogin.status, 200, await firstLogin.text());
  const firstToken = firstLogin.headers.get("set-auth-token");
  assert.ok(firstToken, "Better Auth bearer plugin must return a signed token");

  const firstSession = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${firstToken}` }),
  });
  assert.equal(firstSession?.user.username, "openbot.owner");

  const blockedReset = await authRequest("/change-password", {
    method: "POST",
    headers: {
      authorization: `Bearer ${firstToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      currentPassword: "first test password",
      newPassword: "second test password",
    }),
  });
  assert.equal(blockedReset.status, 404, "HTTP password changes must be disabled");

  await setOwnerCredentials({ operation: "update", username: "renamed.owner" });
  const usernameRevokedSession = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${firstToken}` }),
  });
  assert.equal(usernameRevokedSession, null, "username changes must revoke every existing session");

  const oldUsernameLogin = await signIn("openbot.owner", "first test password");
  assert.equal(oldUsernameLogin.status, 401, "the previous username must stop working");
  const renamedLogin = await signIn("renamed.owner", "first test password");
  assert.equal(renamedLogin.status, 200, await renamedLogin.text());
  const renamedToken = renamedLogin.headers.get("set-auth-token");
  assert.ok(renamedToken);

  await setOwnerCredentials({ operation: "update", password: "second test password" });
  const passwordRevokedSession = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${renamedToken}` }),
  });
  assert.equal(passwordRevokedSession, null, "password changes must revoke every existing session");

  const oldLogin = await signIn("renamed.owner", "first test password");
  assert.equal(oldLogin.status, 401, "the previous password must stop working");
  const secondLogin = await signIn("renamed.owner", "second test password");
  assert.equal(secondLogin.status, 200, await secondLogin.text());
  const secondToken = secondLogin.headers.get("set-auth-token");
  assert.ok(secondToken);

  await setOwnerCredentials({
    operation: "update",
    username: "final.owner",
    password: "third test password",
  });
  const bothRevokedSession = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${secondToken}` }),
  });
  assert.equal(bothRevokedSession, null, "combined credential changes must revoke every session");
  const staleCredentials = await signIn("renamed.owner", "second test password");
  assert.equal(staleCredentials.status, 401);
  const finalLogin = await signIn("final.owner", "third test password");
  assert.equal(finalLogin.status, 200, await finalLogin.text());

  assert.equal(await authPrisma.user.count(), 1);
  assert.equal(await authPrisma.account.count(), 1);
  console.log("Better Auth username-only, password-only, combined updates, and revocation passed.");
} finally {
  await authPrisma.$disconnect();
}
