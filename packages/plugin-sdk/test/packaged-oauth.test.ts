import { expect, test } from "bun:test";
import { createPluginTemplate, packageChanges, parsePluginDefinition } from "../src";

const example = () => {
  const definition = createPluginTemplate("packaged-mcp", "oauth-example");
  definition.connections[0]!.auth = "oauth";
  definition.connections[0]!.oauth = {
    registration: "manual",
    clientType: "confidential",
    tokenEndpointAuthMethod: "client_secret_post",
    accessTokenEnv: "PROVIDER_ACCESS_TOKEN",
    authorizationServer: {
      issuer: "https://provider.example",
      authorizationUrl: "https://provider.example/authorize",
      tokenUrl: "https://provider.example/token",
    },
  };
  return definition;
};

test("packaged OAuth rejects unsafe endpoints and incomplete token delivery configuration", () => {
  expect(parsePluginDefinition(example()).connections[0]!.auth).toBe("oauth");
  for (const tokenUrl of [
    "http://provider.example/token",
    "https://user:pass@provider.example/token",
    "https://provider.example/token#fragment",
  ]) {
    const definition = example();
    definition.connections[0]!.oauth!.authorizationServer!.tokenUrl = tokenUrl;
    expect(() => parsePluginDefinition(definition)).toThrow();
  }
  const missingEnv = example();
  missingEnv.connections[0]!.oauth!.accessTokenEnv = "BAD-NAME";
  expect(() => parsePluginDefinition(missingEnv)).toThrow("environment variable");
  const dynamic = example();
  dynamic.connections[0]!.oauth!.registration = "dynamic";
  expect(() => parsePluginDefinition(dynamic)).toThrow("manual client");
});

test("package review ignores JSON key ordering but identifies changed OAuth issuers", () => {
  const before = example();
  const reordered = JSON.parse(
    JSON.stringify(before, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value
    )
  );
  expect(packageChanges(before, reordered)).toEqual([]);
  reordered.connections[0].oauth.authorizationServer.issuer = "https://other.example";
  expect(packageChanges(before, reordered)[0]).toContain("requires reconnect");
});
