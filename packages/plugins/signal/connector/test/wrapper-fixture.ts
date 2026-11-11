// Synthetic launcher whose runtime keeps inherited pipes open after the launcher exits.
const descendant = Bun.spawn(
  [
    process.execPath,
    "-e",
    `
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
`,
  ],
  { stdin: "ignore", stdout: "inherit", stderr: "inherit" }
);
await Bun.sleep(50);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let boundary: number;
  while ((boundary = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, boundary));
    buffer = buffer.slice(boundary + 1);
    if (request.method === "exitWrapper") process.exit(0);
    const result =
      request.method === "version"
        ? { version: "0.14.10" }
        : request.method === "listAccounts"
          ? []
          : { pid: descendant.pid };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  }
});
process.stdin.on("end", () => process.exit(0));
