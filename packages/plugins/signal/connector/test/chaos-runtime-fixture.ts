// A local synthetic Signal peer. Never contacts Signal or accesses real account state.
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
const dataIndex = process.argv.indexOf("--data-dir");
const root = dataIndex >= 0 ? dirname(process.argv[dataIndex + 1]!) : process.argv[2]!;
const journal = join(root, "peer-journal.jsonl");
const control = () => JSON.parse(readFileSync(join(root, "peer-control.json"), "utf8"));
function record(value: object) {
  const fd = openSync(journal, "a", 0o600);
  try {
    appendFileSync(fd, JSON.stringify({ ...value, pid: process.pid }) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
record({ kind: "boot" });
const emit = (frame: unknown, fragment = false) => {
  const bytes = Buffer.from(JSON.stringify(frame) + "\n");
  if (!fragment) process.stdout.write(bytes);
  else for (let i = 0; i < bytes.length; i += 3) process.stdout.write(bytes.subarray(i, i + 3));
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end: number;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const params = request.params ?? {};
    const reply = (result: unknown, fragment = false) =>
      emit({ jsonrpc: "2.0", id: request.id, result }, fragment);
    const state = control();
    switch (request.method) {
      case "version":
        if (state.crashes > 0) {
          writeFileSync(
            join(root, "peer-control.json"),
            JSON.stringify({ ...state, crashes: state.crashes - 1 })
          );
          process.exit(77);
        }
        reply({ version: "0.14.10" });
        break;
      case "listAccounts":
        reply([state.account]);
        break;
      case "subscribeReceive":
        record({ kind: "subscribe", account: state.account.aci });
        reply(0);
        emit({
          jsonrpc: "2.0",
          method: "receive",
          params: {
            account: state.account.aci,
            envelope: {
              sourceUuid: "synthetic-sender",
              dataMessage: {
                timestamp: 1000,
                message: state.label,
                attachments: [{ id: state.label + "-attachment", contentType: "text/plain" }],
              },
            },
          },
        });
        break;
      case "startLink":
        record({ kind: "provision" });
        reply({ deviceLinkUri: "sgnl://linkdevice?uuid=synthetic&pub_key=synthetic" });
        break;
      case "send":
        record({ kind: "send", message: params.message, account: params.account });
        if (params.message === "commit-and-hang") break;
        if (params.message === "commit-and-crash") process.exit(78);
        reply({ timestamp: 9000 });
        break;
      case "echoChaos":
        setTimeout(() => {
          const result = { value: params.value, text: "日本語 🐈 café" };
          reply(result, true);
          reply({ value: "duplicate must be ignored" }, true);
          emit({ jsonrpc: "2.0", id: "never-issued-" + params.value, result: "unrelated" }, true);
          emit({ jsonrpc: "2.0", method: "receive", params: { synthetic: params.value } }, true);
        }, params.delay);
        break;
      case "listContacts":
        reply([{ uuid: state.account.aci, name: state.label }]);
        break;
      case "getAttachment":
        reply({ data: Buffer.from(state.label).toString("base64") });
        break;
      default:
        reply({});
    }
  }
});
