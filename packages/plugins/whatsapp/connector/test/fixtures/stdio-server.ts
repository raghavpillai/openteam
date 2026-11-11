import { WhatsAppAccount } from "../../account";
import { prepareStore, settings, type Event, type Running } from "../../process";
import { serveWhatsApp } from "../../server";

const home = process.env.WHATSAPP_TEST_HOME;
if (!home) throw new Error("WHATSAPP_TEST_HOME is required for this offline fixture.");
const configuration = settings({
  OPENTEAM_PLUGIN_ACCOUNT_ID: "stdio-test-account",
  WHATSAPP_READ_ONLY: "true",
}, home);
await prepareStore(configuration);
const account = new WhatsAppAccount({
  execute: async (args) => ({
    success: true,
    data: args[0] === "auth" ? { authenticated: false } : { arguments: args },
    error: null,
  }),
  follow: (_args: string[], emit: (event: Event) => void): Running => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => { finish = resolve; });
    queueMicrotask(() => emit({ event: "qr_code", data: { code: "synthetic-stdio-pairing-challenge" } }));
    return { done, stop: async () => { finish(0); await done; } };
  },
}, configuration);
process.once("SIGTERM", () => { void account.close().then(() => process.exit(0)); });
await account.initialize();
await serveWhatsApp(account);
