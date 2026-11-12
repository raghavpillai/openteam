// Synthetic subprocess peer. Every identity and message in this file is test data.
import { closeSync } from "node:fs";
const mode = process.argv[2] ?? "linked";
const account = {
  aci: "11111111-1111-4111-8111-111111111111",
  number: mode === "numberless" ? null : "+12025550100",
};
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let boundary: number;
  while ((boundary = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 1);
    const request = JSON.parse(line);
    const reply = (result: unknown) => emit({ jsonrpc: "2.0", id: request.id, result });
    const params = request.params ?? {};
    switch (request.method) {
      case "version":
        reply({ version: "0.14.10" });
        break;
      case "listAccounts":
        reply(
          mode === "unlinked" ? [] : mode === "multiple" ? [account, { aci: "other" }] : [account]
        );
        break;
      case "subscribeReceive":
        reply(0);
        emit({
          jsonrpc: "2.0",
          method: "receive",
          params: {
            subscription: 0,
            result: {
              account: account.aci,
              envelope: {
                sourceUuid: "sender",
                dataMessage: { timestamp: 1000, message: "synthetic inbox 🐈", attachments: [] },
              },
            },
          },
        });
        break;
      case "listContacts":
        reply([{ uuid: "sender", name: "Synthetic contact" }]);
        break;
      case "listGroups":
        reply([{ id: "synthetic-group", name: "Synthetic group" }]);
        break;
      case "startLink":
        reply({ deviceLinkUri: "sgnl://linkdevice?uuid=synthetic&pub_key=synthetic" });
        break;
      case "finishLink":
        reply(account);
        break;
      case "send":
        if (params.message === "crash") process.exit(2);
        if (params.message !== "timeout") reply({ timestamp: 9000 });
        break;
      case "delay":
        setTimeout(() => reply(params.value), params.ms);
        break;
      case "error":
        emit({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -4, message: "synthetic-provider-secret" },
        });
        break;
      case "badFrame":
        process.stdout.write("bad json\n");
        break;
      case "bigFrame":
        process.stdout.write("x".repeat(8192));
        break;
      case "crash":
        process.exit(2);
      case "closeOutput":
        closeSync(1);
        setInterval(() => {}, 1000);
        break;
      case "closeInput":
        reply({ closed: true });
        closeSync(0);
        setInterval(() => {}, 1000);
        break;
      case "ignoreTermAndBreakFrame":
        process.on("SIGTERM", () => {});
        process.stdout.write("bad json\n");
        setInterval(() => {}, 1000);
        break;
      case "fragmented": {
        const bytes = Buffer.from(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "日本語 🐈 café" }) + "\n"
        );
        let index = 0;
        const timer = setInterval(() => {
          process.stdout.write(bytes.subarray(index, index + 1));
          if (++index === bytes.length) clearInterval(timer);
        }, 1);
        break;
      }
      default:
        reply(params);
    }
  }
});
