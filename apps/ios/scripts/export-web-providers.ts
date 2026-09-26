/** Writes the web provider catalog from packages/contracts for the Swift catalog test.
 * `--check` fails when the fixture is stale; the Swift test fails when Swift drifts. */
import { WEB_PROVIDER_LISTS } from "../../../packages/contracts/src/web-search";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(import.meta.dir, "../Tests/CoreTests/Fixtures/web-provider-catalog.json");
const provider = (info: (typeof WEB_PROVIDER_LISTS)["search"][number]) => ({
  id: info.id,
  name: info.name,
  brand: info.brand,
  description: info.description,
  fields: info.fields.map((field) => ({ id: field.id, label: field.label, secret: field.secret, required: field.required, placeholder: field.placeholder ?? "" })),
  setupUrl: info.setupUrl ?? null,
});
const json = `${JSON.stringify({ search: WEB_PROVIDER_LISTS.search.map(provider), fetch: WEB_PROVIDER_LISTS.fetch.map(provider) }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {}
  if (current !== json) {
    console.error("Tests/CoreTests/Fixtures/web-provider-catalog.json is stale. Run: bun apps/ios/scripts/export-web-providers.ts, then update WebProviderCatalog in Sources/Core/WebProviderSettings.swift to match.");
    process.exit(1);
  }
} else writeFileSync(target, json);
