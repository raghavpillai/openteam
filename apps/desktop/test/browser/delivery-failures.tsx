/** Shipping UI + controller + HTTP client; only the remote service is synthetic. */
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createOpenTeamClient } from "@openteam/client-core";
import {
  createDurableSendController,
  classifyDurableSendError,
  messageDeliveryAcceptance,
  type DurableSendPayload,
} from "@openteam/product-core/durable-delivery";
import { PromptInput } from "../../src/renderer/components/ai-elements/prompt-input";
import { DeliveryFooter } from "../../src/renderer/components/openteam/delivery-footer";
import { ExternalDraftCard } from "../../src/renderer/components/openteam/external-draft-card";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import { api } from "../../src/renderer/client/openteam-api";
import "../../src/renderer/styles.css";

const params = new URLSearchParams(location.search);
const server = params.get("server");
if (params.has("reset")) {
  localStorage.removeItem("failure-qa-journal");
  params.delete("reset");
  history.replaceState(null, "", `${location.pathname}?${params}`);
}
if (!server || new URL(server).hostname !== "127.0.0.1" || window.openteam)
  throw new Error("Use a disposable loopback fixture in a browser");
const client = createOpenTeamClient({ baseUrl: server });
Object.assign(api, client);
let clock = Date.now();
let storageFailure = false;
let uploadHangs = false;
const controller = createDurableSendController(
  `failure-ui:${server}`,
  {
    read: async () => JSON.parse(localStorage.getItem("failure-qa-journal") ?? "null"),
    write: async (journal) => {
      if (storageFailure) throw new Error("Could not save message on this device.");
      localStorage.setItem("failure-qa-journal", JSON.stringify(journal));
    },
  },
  {
    now: () => clock,
    ackTimeoutMs: 1000,
    attachmentCommitTimeoutMs: 40,
    dispatch: (record) =>
      client.sendChannelMessage(
        "fixture",
        record.payload.content,
        record.payload.attachments,
        undefined,
        { clientId: record.nonce }
      ),
    resolveAcceptance: async (record) =>
      messageDeliveryAcceptance(await client.messageDeliveryStatus("fixture", record.nonce)),
    classifyError: classifyDurableSendError,
    commitStagedAttachments: async () => {
      if (uploadHangs) await new Promise(() => {});
      throw Object.assign(new Error("This attachment cannot be uploaded."), {
        code: "attachment_commit_invalid",
        status: 422,
      });
    },
    isTransportDown: () => !navigator.onLine,
  }
);
await controller.restore();
window.addEventListener("online", () => void controller.flush());
Object.assign(window, {
  deliveryQA: {
    records: controller.getSnapshot,
    hangUploads: () => {
      uploadHangs = true;
    },
    flush: controller.flush,
    failStorage: (value: boolean) => {
      storageFailure = value;
    },
    expire: async () => {
      clock += 2000;
      await controller.expireAcknowledgements();
    },
  },
});
function Fixture() {
  const records = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const recoveries = useSyncExternalStore(controller.subscribe, controller.getRecoverySnapshot);
  const [recovery, setRecovery] = useState<{
    id: string;
    payload: DurableSendPayload;
    message?: string;
  } | null>(null);
  useEffect(() => {
    if (!recovery && recoveries[0])
      setRecovery({
        id: recoveries[0].nonce,
        payload: recoveries[0].payload,
        message: recoveries[0].failure?.message,
      });
  }, [recoveries, recovery]);
  return (
    <TooltipProvider>
      <main className="mx-auto flex max-w-[780px] flex-col gap-6 p-8">
        <h1>Connection and message recovery</h1>
        <section aria-label="Chat delivery" className="flex flex-col gap-4">
          {records.map((record) => (
            <article
              className="self-end rounded-xl bg-muted p-4"
              data-phase={record.phase}
              key={record.nonce}
            >
              <p>{record.payload.content}</p>
              <DeliveryFooter
                delivery={record}
                onCancel={async (nonce) => {
                  const payload = await controller.cancelQueued(nonce);
                  if (payload) setRecovery({ id: nonce, payload });
                }}
                onDelete={controller.deleteFailed}
                onResend={async (nonce) => {
                  await controller.resendFailed(nonce);
                }}
              />
            </article>
          ))}
          <PromptInput
            placeholder="Message recovery test"
            onStage={async (file, name) => ({
              stagingId: crypto.randomUUID(),
              fileName: name ?? "fixture.txt",
              mimeType: file.type || "text/plain",
              byteSize: file.size,
              kind: "text",
            })}
            recovery={recovery}
            onRecoveryConsumed={async (nonce) => {
              await controller.acknowledgeRecovery(nonce);
              setRecovery(null);
            }}
            onSubmit={(content, attachments, options) =>
              controller.enqueue({
                target: { channelId: "fixture", conversationId: null },
                payload: { content, attachments, ...options },
              })
            }
          />
        </section>
        <section aria-label="External message draft">
          <ExternalDraftCard
            message={
              {
                id: "draft",
                metadata: {
                  cardState: "pending",
                  draft: { verification: { identity: "fixture@example.test" } },
                },
              } as any
            }
            draft={{
              platform: "email",
              providerIdentifier: "fixture",
              from: "fixture@example.test",
              to: ["recipient@example.test"],
              subject: "Synthetic draft",
              body: "Keep this draft on failure",
            }}
          />
        </section>
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
