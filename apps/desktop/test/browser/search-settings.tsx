import React from "react";
import { createRoot } from "react-dom/client";
import { createOpenTeamClient } from "@openteam/client-core";
import { api } from "../../src/renderer/client/openteam-api";
import { WebSearchSettingsPanel } from "../../src/renderer/components/openteam/settings/web-search";

const fixture = (window as any).searchFixture as { baseUrl: string; token: string };
const client = createOpenTeamClient({
  baseUrl: fixture.baseUrl,
  getAuthToken: () => fixture.token,
});
api.webSearchSettings = client.webSearchSettings;
api.updateWebSearchSettings = client.updateWebSearchSettings;
api.webFetchSettings = client.webFetchSettings;
api.updateWebFetchSettings = client.updateWebFetchSettings;
const root = createRoot(document.getElementById("root")!);
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
  checks++;
};
const selector = () => document.querySelector<HTMLSelectElement>('[aria-label="Search provider"]')!;
const keyInput = () => document.querySelector<HTMLInputElement>('[aria-label="Search API key"]')!;
const saveButton = () => document.querySelector<HTMLButtonElement>("button")!;
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await wait();
  }
  throw new Error("Timed out waiting for search settings UI");
}
async function provider(value: string) {
  selector().value = value;
  selector().dispatchEvent(new Event("change", { bubbles: true }));
  await wait();
}
async function key(value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
    keyInput(),
    value
  );
  keyInput().dispatchEvent(new Event("input", { bubbles: true }));
  await wait();
}
async function save() {
  assert(!saveButton().disabled, "changed settings can be saved");
  saveButton().click();
  await wait();
  await until(
    () =>
      !document.querySelector("fieldset")!.disabled &&
      saveButton().disabled &&
      Boolean(document.querySelector('[role="status"]')?.textContent?.startsWith("Saved."))
  );
  assert(keyInput().value === "", "key input cleared after save");
}

(async () => {
  root.render(<WebSearchSettingsPanel />);
  await until(() => Boolean(selector()) && !document.querySelector("fieldset")!.disabled);
  assert(selector().options.length === 5, "all four providers visible alongside unset option");
  assert(selector().value === "", "fresh DB shows not configured");
  assert(document.body.textContent!.includes("Not configured"), "setup guidance shown");
  await provider("exa");
  await key("synthetic-ui-search-key");
  assert(keyInput().type === "password", "credential masked");
  assert(
    !document.body.textContent!.includes("synthetic-ui-search-key"),
    "credential absent from UI text"
  );
  await save();
  assert(keyInput().placeholder === "Key saved", "saved status without returning the key");
  assert((await client.webSearchSettings()).configured, "UI save reached real server and database");
  // Remount exercises a fresh read, not the component's draft state.
  root.render(<WebSearchSettingsPanel key="reloaded" />);
  await wait();
  await until(() => !document.querySelector("fieldset")!.disabled);
  assert(
    selector().value === "exa" && keyInput().value === "",
    "saved provider survives reload without key disclosure"
  );
  (window as any).searchReady = true;
  await wait(450);
  await provider("brave");
  await save();
  assert(!(await client.webSearchSettings()).hasApiKey, "provider change removed old credential");
  await key("synthetic-second-ui-key");
  await save();
  document.querySelector<HTMLInputElement>('[aria-label="Remove search API key"]')!.click();
  await wait();
  await save();
  assert(!(await client.webSearchSettings()).hasApiKey, "remove key is persisted");
  await provider("");
  await save();
  assert((await client.webSearchSettings()).provider === null, "disconnect is persisted");
  assert(
    !JSON.stringify(localStorage).includes("synthetic-ui-search-key"),
    "key absent from local storage"
  );
  const fetchSelect = document.querySelector<HTMLSelectElement>('[aria-label="Fetch provider"]')!;
  const fetchKey = document.querySelector<HTMLInputElement>('[aria-label="Fetch API key"]')!;
  const fetchFieldset = fetchSelect.closest("fieldset")!;
  const fetchButton = fetchFieldset.querySelector<HTMLButtonElement>("button")!;
  await until(() => !fetchFieldset.disabled);
  assert(
    fetchSelect.options.length === 4 && fetchSelect.value === "",
    "fetch starts unconfigured and offers three explicit providers"
  );
  assert(fetchKey.disabled, "unconfigured fetch does not request a key");
  assert(!(await client.webFetchSettings()).configured, "no implicit fetch fallback");
  fetchSelect.value = "builtin";
  fetchSelect.dispatchEvent(new Event("change", { bubbles: true }));
  await wait();
  fetchButton.click();
  await wait();
  await until(() => !fetchFieldset.disabled && fetchButton.disabled);
  assert((await client.webFetchSettings()).configured, "built-in fetch requires explicit save");
  assert(fetchKey.disabled, "built-in fetch needs no key");
  fetchSelect.value = "exa";
  fetchSelect.dispatchEvent(new Event("change", { bubbles: true }));
  await wait();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
    fetchKey,
    "synthetic-ui-fetch-key"
  );
  fetchKey.dispatchEvent(new Event("input", { bubbles: true }));
  await wait();
  fetchButton.click();
  await wait();
  await until(() => !fetchFieldset.disabled && fetchButton.disabled);
  assert(fetchKey.value === "", "fetch key cleared after save");
  assert((await client.webFetchSettings()).configured, "fetch setting persisted through API");
  assert(
    (await client.webSearchSettings()).provider === null,
    "fetch configuration is independent of search"
  );
  fetchSelect.value = "builtin";
  fetchSelect.dispatchEvent(new Event("change", { bubbles: true }));
  await wait();
  fetchButton.click();
  await wait();
  await until(() => !fetchFieldset.disabled && fetchButton.disabled);
  assert(!(await client.webFetchSettings()).hasApiKey, "switching to built-in removes fetch key");
  fetchSelect.value = "";
  fetchSelect.dispatchEvent(new Event("change", { bubbles: true }));
  await wait();
  fetchButton.click();
  await wait();
  await until(() => !fetchFieldset.disabled && fetchButton.disabled);
  assert((await client.webFetchSettings()).provider === null, "fetch can be disabled again");
  (window as any).searchResults = { passed: checks, realServer: true, realDatabase: true };
})().catch((error) => {
  (window as any).searchResults = { error: String(error), stack: error.stack };
});
