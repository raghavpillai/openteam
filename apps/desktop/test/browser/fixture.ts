// One shell for every fixture page: ?page=<name> runs <name>.tsx from this directory.
const params = new URLSearchParams(location.search);
const server = params.get("server");
if (server) localStorage.setItem("openteam:server-url", server);
const pages = import.meta.glob("./*.tsx");
const page = pages[`./${params.get("page")}.tsx`];
if (!page) throw new Error(`Unknown fixture page: ${params.get("page")}`);
await page();
