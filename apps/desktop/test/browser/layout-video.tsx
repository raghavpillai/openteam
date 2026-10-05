import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Conversation,
  ConversationContent,
} from "../../src/renderer/components/ai-elements/conversation";
import { MessageResponse } from "../../src/renderer/components/ai-elements/message";
import { MessageImageGallery } from "../../src/renderer/components/openteam/image-attachment";
import "../../src/renderer/styles.css";
const originalFetch = window.fetch;
window.fetch = (input, init) =>
  String(input).includes("/api/v0/assets/")
    ? new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              new Response(
                '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><rect width="400" height="800" fill="#28485a"/><rect x="35" y="50" width="330" height="180" rx="16" fill="#91c4d9"/><text x="40" y="295" fill="white" font-size="28">Uploaded image</text><path d="M40 340h300M40 390h240M40 440h280" stroke="#91c4d9" stroke-width="12"/></svg>',
                { headers: { "Content-Type": "image/svg+xml" } }
              )
            ),
          3000
        )
      )
    : originalFetch(input, init);
function Demo() {
  const [open, setOpen] = useState(false);
  (window as any).openConversation = () => setOpen(true);
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#101010",
        color: "#eee",
        fontSize: 18,
      }}
    >
      <header style={{ padding: "18px 28px", borderBottom: "1px solid #333" }}>
        Chat loading · desktop renderer
      </header>
      {open ? (
        <Conversation>
          <ConversationContent overlayScrollbars className="px-8" scrollClassName="h-full">
            <div style={{ maxWidth: 610, background: "#262626", padding: 18, borderRadius: 20 }}>
              <MessageResponse>
                {
                  "## Setup details\n\n- Your workspace is connected.\n- The settings are ready for review.\n- The image below shows the current configuration."
                }
              </MessageResponse>
            </div>
            <div
              style={{
                alignSelf: "flex-end",
                display: "flex",
                flexDirection: "column",
                alignItems: "end",
                gap: 8,
              }}
            >
              <MessageImageGallery
                images={[
                  {
                    url: "/api/v0/assets/layout/content",
                    width: 400,
                    height: 800,
                    alt: "Uploaded image",
                  },
                ]}
              />
              <div style={{ padding: 16, borderRadius: 20, background: "#505050" }}>
                Can you help with this configuration?
              </div>
            </div>
            <div style={{ maxWidth: 610, background: "#262626", padding: 18, borderRadius: 20 }}>
              <MessageResponse>
                {
                  "## Next steps\n\n1. Open the workspace settings.\n2. Check the connected services.\n3. Save your changes."
                }
              </MessageResponse>
            </div>
            <p>Ready when you are.</p>
          </ConversationContent>
        </Conversation>
      ) : (
        <div style={{ margin: "auto" }}>Opening conversation…</div>
      )}
      <footer style={{ padding: 18, borderTop: "1px solid #333", color: "#888" }}>Message…</footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Demo />);
console.log("VIDEO_READY");
