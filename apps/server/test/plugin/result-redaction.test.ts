import { expect, test } from "bun:test";
import { redactConnectionSecrets } from "../../src/services/plugin/values";

test("OAuth and configured secrets stay redacted even inside free-form result text", () => {
  const secrets = [
    "access-private",
    "refresh-private",
    "identity-private",
    "client-private",
    "registration-private",
    "verifier-private",
    "state-private",
    "callback-private",
    "url-private",
    "header-private",
    "env-private",
    "field-private",
    "root-private",
  ];
  const result = { text: secrets.join(" "), access_token: "unrecognized-returned-token" };
  const scrubbed = redactConnectionSecrets(result, {
    configuration: {},
    credentials: {
      bearerToken: "root-private",
      headers: { "X-Custom": "header-private" },
      env: { CUSTOM: "env-private" },
      values: { key: "field-private" },
      oauth: {
        state: "state-private",
        codeVerifier: "verifier-private",
        callbackSessionId: "callback-private",
        authorizationUrl: "url-private",
        clientInformation: {
          client_secret: "client-private",
          registration_access_token: "registration-private",
        },
        tokens: {
          access_token: "access-private",
          refresh_token: "refresh-private",
          id_token: "identity-private",
          token_type: "Bearer",
        },
      },
    },
  });
  for (const secret of secrets) expect(JSON.stringify(scrubbed)).not.toContain(secret);
  expect((scrubbed as any).access_token).toBe("[redacted]");
});
