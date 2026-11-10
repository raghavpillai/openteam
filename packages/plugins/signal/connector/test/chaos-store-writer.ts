// Synthetic crash fixture; writes only to the temporary path supplied by its test.
import { MessageStore } from "../store";
const store = new MessageStore(process.argv[2]!);
store.bind({ aci: "chaos-self", number: "+12025550100" });
const incoming = (timestamp: number, message: string | null, data: any = {}) => ({
  account: "chaos-self",
  envelope: { sourceUuid: "chaos-alice", dataMessage: { timestamp, message, ...data } },
});
store.capture(incoming(1000, "must disappear", { attachments: [{ id: "redacted-file" }] }));
store.capture(incoming(2000, "survivor"));
store.beginSend("uncertain", { to: "chaos-alice", body: "maybe-sent" });
store.capture(incoming(3000, null, { remoteDelete: { timestamp: 1000 } }));
store.db.exec("BEGIN IMMEDIATE");
store.db.exec("UPDATE messages SET body='uncommitted corruption',attachments='[]',deleted=0");
store.db.exec("UPDATE sends SET state='sent',result='{}'");
process.stdout.write("in-flight\n");
setInterval(() => {}, 1000);
