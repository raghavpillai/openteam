// Offline provider simulator. No WhatsApp endpoint or real account is used.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2), store = args[args.indexOf("--store") + 1]!;
const authenticated = join(store, "synthetic-authenticated");
const emit = (event: string, data?: unknown) => process.stderr.write(JSON.stringify({ event, data }) + "\n");
if (!args.includes("--events")) {
  console.log(JSON.stringify({ success: true, data: args.includes("status") ? { authenticated: existsSync(authenticated) } : { messages: [] }, error: null }));
} else {
  appendFileSync(join(store, "native-boots"), `${process.pid}\n`);
  const sync = args.includes("sync");
  const socket = sync ? Bun.listen({ unix: join(store, ".send.sock"), socket: { data() {} } }) : undefined;
  if (sync) emit("connected");
  else emit("qr_code", { code: "synthetic-initial-qr" });
  let previous = "";
  const timer = setInterval(() => {
    const value = existsSync(join(store, "control")) ? readFileSync(join(store, "control"), "utf8") : "";
    if (!value || value === previous) return;
    previous = value;
    if (value.startsWith("qr:")) emit("qr_code", { code: value });
    if (value === "invalidate") emit("warning", { code: "auth_connect_retry" });
    if (value === "bootstrap" && !sync) { writeFileSync(authenticated, "synthetic-device-keys", { mode: 0o600 }); emit("connected"); }
    if (value === "finish" && !sync) process.exit(0);
    if (value === "disconnect" && sync) emit("disconnected");
    if (value === "recover" && sync) emit("connected");
  }, 10);
  process.once("SIGTERM", () => { clearInterval(timer); socket?.stop(true); process.exit(0); });
}
