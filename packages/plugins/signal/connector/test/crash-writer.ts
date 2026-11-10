import { MessageStore } from "../store";
const store = new MessageStore(process.argv[2]!);
store.bind({ aci: "crash-test" });
for (let i = 0; i < 1000; i++)
  store.capture({
    account: "crash-test",
    envelope: {
      sourceUuid: "sender",
      dataMessage: { timestamp: 1000 + i, message: `durable ${i}` },
    },
  });
process.stdout.write("committed\n");
setInterval(() => {}, 1000);
