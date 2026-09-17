import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ChannelMessageView } from "@openteam/contracts";
import { createOpenTeamClient } from "@openteam/client-core";
import { MobileExternalDraftCard } from "../../src/components/external-draft-card";

const server = new URLSearchParams(location.search).get("server")!;
if (new URL(server).hostname !== "127.0.0.1") throw new Error("Loopback fixture only");
const client = createOpenTeamClient({ baseUrl: server });
const draft = {
  platform: "email" as const,
  providerIdentifier: "fixture",
  from: "a@example.test",
  to: ["b@example.test"],
  subject: "Synthetic",
  body: "Keep my mobile draft",
};
function Fixture() {
  const [message, setMessage] = useState({
    id: "draft",
    metadata: { cardState: "pending", draft: { verification: { identity: draft.from } } },
  } as ChannelMessageView);
  Object.assign(window, {
    mobileFixtureApi: {
      mutateExternalDraft: async (...args: Parameters<typeof client.mutateExternalDraft>) => {
        if ((window as any).mobileDisconnected) return false;
        const result = await client.mutateExternalDraft(...args);
        setMessage(result.message);
        return true;
      },
    },
    mobileFixtureUpdate: (state: string) =>
      setMessage((current) => ({
        ...current,
        metadata: { ...(current.metadata as object), cardState: state },
      })),
  });
  return <MobileExternalDraftCard message={message} draft={draft} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
