import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { refreshAuthSession } from "../../src/renderer/client/auth";
import { FileAttachmentPreview } from "../../src/renderer/components/openteam/file-attachment";

const params = new URLSearchParams(location.search);
const session = await refreshAuthSession();
if (session.status !== "authenticated") throw new Error("Fixture sign-in failed");
createRoot(document.getElementById("root")!).render(
  <>
    <FileAttachmentPreview
      attachment={{
        assetId: params.get("asset")!,
        fileName: "shipping-label.PDF",
        byteSize: Number(params.get("bytes")),
        mimeType: "application/pdf",
        kind: "pdf",
      }}
      open
      onOpenChange={() => undefined}
    />
    <Toaster />
  </>
);
