import { createRoot } from "react-dom/client";
import { signIn } from "../../src/renderer/client/auth";
import { useAuthenticatedResource } from "../../src/renderer/hooks/use-authenticated-resource";
import { MessageResponse } from "../../src/renderer/components/ai-elements/message";
import { FileAttachmentCard } from "../../src/renderer/components/openteam/file-attachment";
import "../../src/renderer/styles.css";
function PrivateImage({ alias }: { alias: string }) {
  const source = useAuthenticatedResource(`${alias}${"a".repeat(64)}`);
  return <img alt={alias} src={source ?? undefined} data-private-image />;
}
async function main() {
  await signIn("qa", "fixture-only");
  createRoot(document.getElementById("root")!).render(
    <>
      <PrivateImage alias="/api/assets/" />
      <PrivateImage alias="/api/v0/assets/" />
      <MessageResponse>{`![Private Markdown photo](/api/v0/assets/${"a".repeat(64)})`}</MessageResponse>
      <FileAttachmentCard
        attachment={{
          assetId: "b".repeat(64),
          fileName: "private.md",
          mimeType: "text/markdown",
          byteSize: 30,
          kind: "file",
        }}
      />
    </>
  );
}
void main();
