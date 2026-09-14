// Manual CUA fixture: shipping composer and durable staging, synthetic sends.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/renderer/styles.css";
if (window.openteam) throw new Error("Use the isolated browser fixture.");
window.fetch = async () => {
  throw new Error("No network calls in this fixture.");
};
const [{ PromptInput }, stages, { TooltipProvider }] = await Promise.all([
  import("../../src/renderer/components/ai-elements/prompt-input"),
  import("../../src/renderer/lib/durable-sends"),
  import("../../src/renderer/components/ui/tooltip"),
]);
function InputParityQA() {
  const [count, setCount] = useState(0);
  const [sent, setSent] = useState<unknown>(null);
  return (
    <TooltipProvider>
      <main className="mx-auto flex min-h-screen max-w-[900px] flex-col justify-end gap-5 p-8">
        <h1>Input parity QA — shipping desktop composer</h1>
        <p>Staged attachments: {count}. Synthetic sends only.</p>
        <pre aria-label="Last submitted payload">{JSON.stringify(sent, null, 2)}</pre>
        <PromptInput
          placeholder="Message Input QA"
          onAttachmentsChange={setCount}
          onStage={stages.stageDesktopDeliveryFile}
          onDiscardStages={stages.discardDesktopDeliveryStages}
          onSubmit={async (content, _assets, options) =>
            setSent({
              characters: content.length,
              tail: content.slice(-40),
              files:
                options?.stagedAttachments?.map((f) => ({ name: f.fileName, bytes: f.byteSize })) ??
                [],
            })
          }
        />
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<InputParityQA />);
