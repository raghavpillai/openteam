import { WhatsAppAccount } from "../../account";
import { prepareStore, settings, WacliProcess } from "../../process";
import { serveWhatsApp } from "../../server";
const configuration = settings();
await prepareStore(configuration);
const account = new WhatsAppAccount(new WacliProcess(process.env.WHATSAPP_TEST_NATIVE_EXECUTABLE!, configuration), configuration);
process.once("SIGTERM", () => { void account.close().then(() => process.exit(0)); });
await account.initialize();
await serveWhatsApp(account);
