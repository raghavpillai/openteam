// Synthetic subprocess peer. Every identity and message in this file is test data.
const account = { aci: "11111111-1111-4111-8111-111111111111", number: "+12025550100" };
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const directory = (prefix: string, key: string) =>
  Array.from({ length: 12 }, (_, i) => ({ [key]: `${prefix}-${String(i).padStart(3, "0")}`, name: `Synthetic ${prefix} ${i}` }));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let boundary: number;
  while ((boundary = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, boundary));
    buffer = buffer.slice(boundary + 1);
    const reply = (result: unknown) => emit({ jsonrpc: "2.0", id: request.id, result });
    const params = request.params ?? {};
    switch (request.method) {
      case "version": reply({ version: "0.14.10" }); break;
      case "listAccounts": reply([account]); break;
      case "subscribeReceive":
        reply(0);
        emit({ jsonrpc: "2.0", method: "receive", params: { subscription: 0, result: { account: account.aci, envelope: {
          sourceUuid: "sender", dataMessage: { timestamp: 1000, message: "synthetic inbox 🐈", attachments: [{ id: "attachment", size: 80000 }] } } } } });
        break;
      case "listContacts": reply(directory("contact", "uuid").filter((c) => !params.recipient || params.recipient.includes(c.uuid))); break;
      case "listGroups": reply(directory("group", "id").filter((g) => !params.groupId || params.groupId.includes(g.id))); break;
      case "getAttachment": reply({ data: Buffer.alloc(80000, 65).toString("base64") }); break;
      case "send": reply({ timestamp: 9000 }); break;
      case "delay": setTimeout(() => reply(params.value), params.ms); break;
      case "error": emit({ jsonrpc: "2.0", id: request.id, error: { code: -4, message: "synthetic-provider-secret" } }); break;
      default: reply(params);
    }
  }
});
