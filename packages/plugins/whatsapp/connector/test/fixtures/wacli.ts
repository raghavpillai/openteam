#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const store = args[args.indexOf("--store") + 1]!;
const mode = existsSync(`${store}/mode`) ? readFileSync(`${store}/mode`, "utf8") : "normal";
appendFileSync(`${store}/calls`, JSON.stringify(args) + "\n");
if (mode === "large") { process.stdout.write("x".repeat(5 * 1024 * 1024)); setInterval(() => {}, 1000); }
else if (mode === "hang") {
  writeFileSync(`${store}/native.pid`, String(process.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
else if (args.includes("--events")) {
  process.stderr.write(JSON.stringify({ event: "qr_code", data: { code: "private-qr-payload" } }) + "\n");
  process.stderr.write("unstructured secret diagnostic\n");
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (mode === "error") {
  console.log(JSON.stringify({ success: false, data: null, error: "specific upstream error" })); process.exit(1);
} else if (mode === "store_warning") {
  console.log(JSON.stringify({ success: true, data: { sent: true, id: "SENT_ID", store_warning: "local store unavailable" }, error: null }));
} else {
  console.log(JSON.stringify({ success: true, data: { authenticated: false, messages: [], page: { has_more: true, next_cursor: "next" }, source: { scope: "local_archive", last_sync_at: null } }, error: null }));
}
