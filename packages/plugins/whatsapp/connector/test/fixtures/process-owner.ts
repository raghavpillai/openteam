import { settings, WacliProcess } from "../../process";

const [home, executable, mode] = process.argv.slice(2);
const configuration = settings({ PATH: process.env.PATH, OPENTEAM_PLUGIN_ACCOUNT_ID: "account-a", WHATSAPP_MEDIA_ROOT: home }, home);
const native = new WacliProcess(executable!, configuration);
if (mode === "follow") native.follow(["sync"], () => {});
else void native.execute(["wait"], false, 60000).catch(() => {});
