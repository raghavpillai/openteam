import { StrictMode, lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Conversation,
  ConversationContent,
} from "../../src/renderer/components/ai-elements/conversation";
import {
  MessageResponse,
  MessageRendererBoundary,
} from "../../src/renderer/components/ai-elements/message";
import { VirtualizedTimeline } from "../../src/renderer/components/openteam/virtualized-timeline";
import { MessageImageGallery } from "../../src/renderer/components/openteam/image-attachment";
import "../../src/renderer/styles.css";

const root = createRoot(document.getElementById("root")!);
const reports: string[] = [];
const rendererFailure = new URLSearchParams(location.search).get("rendererFailure");
const pause = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 640; i++) {
    if (condition()) return;
    await pause();
  }
  throw new Error("Timed out waiting for layout");
};
const FileCards = lazy(() =>
  import("../../src/renderer/components/openteam/file-attachment").then((module) => ({
    default: module.MessageFileAttachments,
  }))
);
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><rect width="400" height="800" fill="teal"/></svg>';
const downloads: Array<() => void> = [];
const originalFetch = window.fetch;
window.fetch = (input, init) =>
  String(input).includes("/api/v0/assets/")
    ? new Promise((resolve) =>
        downloads.push(() =>
          resolve(new Response(svg, { headers: { "Content-Type": "image/svg+xml" } }))
        )
      )
    : originalFetch(input, init);
const messages = Array.from({ length: 80 }, (_, i) => ({
  id: `message-${i}`,
  type: "message",
  index: i,
}));
const contents: Record<string, string> = {
  code: "```typescript\nconst ready: boolean = true;\nconsole.log(ready);\n```",
  markdown:
    "## Formatting\n\n- The first list item.\n- The second item wraps over a few lines with more text.\n\n| Item | State |\n| --- | --- |\n| Chat | Ready |",
  math: "## Formula\n\n$$\\frac{a^2+b^2}{c^2}$$",
  diagram: "```mermaid\ngraph TD\n  A[Prepare] --> B[Measure]\n  B --> C[Reveal]\n```",
  badDiagram: "```mermaid\nthis is not valid diagram syntax\n```",
  inlineImage: "## Screenshot\n\n![Inline image](/api/v0/assets/inline/content)",
};
function Fixture({ kind, visit, overlay }: { kind: string; visit: number; overlay: boolean }) {
  const [rendererPending, setRendererPending] = useState(kind === "slowRenderer");
  useEffect(() => {
    if (!rendererPending) return;
    const timer = setTimeout(() => setRendererPending(false), 9000);
    return () => clearTimeout(timer);
  }, [rendererPending]);
  const [historyPending, setHistoryPending] = useState(kind === "delayedHistory");
  useEffect(() => {
    if (!historyPending) return;
    const timer = setTimeout(() => setHistoryPending(false), 800);
    return () => clearTimeout(timer);
  }, [historyPending]);
  return (
    <Conversation key={`${kind}-${visit}`} style={{ height: 640, width: 560 }}>
      <ConversationContent
        overlayScrollbars={overlay}
        initialContentPending={historyPending}
        className="px-4 py-6"
        scrollClassName="h-full"
      >
        <VirtualizedTimeline
          conversationId={`layout-${kind}`}
          entries={historyPending ? [] : messages}
          focus={null}
          messageIdsForEntry={(entry) => [entry.id]}
          renderEntry={(entry) => (
            <div data-message-id={entry.id}>
              {entry.index === 78 ? (
                <>
                  {rendererPending ? (
                    <div data-chat-layout-pending>Preparing content</div>
                  ) : (
                    <MessageResponse>{contents[kind] ?? "A photo and document."}</MessageResponse>
                  )}
                  {kind === "media" && (
                    <>
                      <MessageImageGallery
                        images={[
                          { url: "/api/v0/assets/portrait/content", width: 400, height: 800 },
                        ]}
                      />
                      <MessageRendererBoundary content="Attachment previews unavailable. notes.pdf">
                        <Suspense fallback={<div data-chat-layout-pending>Loading file</div>}>
                          <FileCards
                            attachments={[
                              {
                                assetId: "document",
                                fileName: "notes.pdf",
                                mimeType: "application/pdf",
                                byteSize: 1234,
                                kind: "pdf",
                              },
                            ]}
                          />
                        </Suspense>
                      </MessageRendererBoundary>
                    </>
                  )}
                </>
              ) : (
                <p className="py-3">
                  {entry.index === 79 ? "Latest message" : `Earlier message ${entry.index}`}
                </p>
              )}
            </div>
          )}
        />
      </ConversationContent>
    </Conversation>
  );
}

const geometry = () => {
  const message = document.querySelector('[data-message-id="message-79"]')!.getBoundingClientRect();
  const previous = document
    .querySelector('[data-message-id="message-78"]')!
    .getBoundingClientRect();
  return [previous.y, previous.height, message.y, message.height];
};
async function run() {
  // Keep the scroll implementation identical across first mount and revisit.
  // Modules remain loaded in this browser; these are not cold-process timings.
  for (const overlay of [true, false]) {
    for (const kind of rendererFailure
      ? [rendererFailure === "plugin" ? "code" : rendererFailure === "file" ? "media" : "markdown"]
      : [
          "delayedHistory",
          "slowRenderer",
          "markdown",
          "code",
          "math",
          "diagram",
          "badDiagram",
          "media",
          "inlineImage",
        ]) {
      for (let visit = 0; visit < 2; visit++) {
        root.render(null);
        await pause();
        root.render(
          <StrictMode>
            <Fixture kind={kind} visit={visit} overlay={overlay} />
          </StrictMode>
        );
        await waitFor(() => !!document.querySelector('[data-chat-layout-ready="true"]'));
        check(
          !document.querySelector("[data-chat-layout-pending]"),
          `${kind}: revealed unresolved renderer`
        );
        if (rendererFailure) {
          check(
            document.querySelector("[data-chat-renderer-fallback]"),
            "Failed renderer must leave readable text"
          );
          check(
            document.body.textContent?.includes(
              rendererFailure === "file" ? "notes.pdf" : contents[kind]!
            ),
            "Fallback lost the message content"
          );
        }
        if (kind === "diagram")
          check(
            document.querySelector('[data-streamdown="mermaid"] svg'),
            "Diagram must exist at reveal"
          );
        if (kind === "badDiagram")
          check(
            document.querySelector("[data-chat-diagram-error]"),
            "Broken diagrams must finish with an error"
          );
        if (kind === "media" && rendererFailure !== "file")
          check(document.querySelector("article.group\\/file"), "File card must exist at reveal");
        const before = geometry();
        // Media is deliberately still downloading when the ready conversation opens.
        for (const release of downloads.splice(0)) release();
        for (let frame = 0; frame < 60; frame++) {
          await new Promise(requestAnimationFrame);
          const after = geometry();
          check(
            before.every((value, index) => Math.abs(value - after[index]!) <= 1),
            `${kind} visit ${visit}: geometry moved after reveal: ${JSON.stringify({ before, after })}`
          );
        }
        reports.push(
          `${kind}, ${overlay ? "overlay" : "native"} scroll, ${visit ? "revisit" : "first mount"}: stable from initial reveal`
        );
      }
    }
  }
}
run()
  .then(() => console.log("IMAGE_LAYOUT_RESULT " + JSON.stringify({ reports })))
  .catch((error) =>
    console.log(
      "IMAGE_LAYOUT_RESULT " + JSON.stringify({ reports, error: String(error), stack: error.stack })
    )
  );
