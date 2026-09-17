import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ApprovalView, ChannelMessageView } from "@openteam/contracts";
import { ApprovalCard } from "../../src/renderer/components/openteam/chat-pane";
import { RichMessage } from "../../src/renderer/components/openteam/rich-message";
import { api } from "../../src/renderer/client/openteam-api";
import "../../src/renderer/styles.css";

const qa = {
  calls: [] as unknown[][],
  result: null as any,
  fail: false,
  hold: false,
  release: () => {},
  render: (_value: any) => {},
  update: (_metadata: any) => {},
};
Object.assign(window, { permissionQA: qa });
let current: any;
const call = async (kind: string, ...args: unknown[]) => {
  qa.calls.push([kind, ...args]);
  if (qa.hold)
    await new Promise<void>((resolve) => {
      qa.release = resolve;
    });
  if (qa.fail) throw new Error("fixture-secret-should-never-be-displayed");
  return (
    qa.result ?? {
      accepted: true,
      message: {
        ...current.message,
        metadata: {
          ...current.message?.metadata,
          respondedValue: args[1],
          cardState: "submitted",
          secretProvided: true,
          computerHandoffState: kind === "handoff" && args[1] === "skip" ? "skipped" : "active",
        },
      },
    }
  );
};
api.respondToWidget = ((...args: any[]) => call("widget", ...args)) as any;
api.dismissWidget = ((...args: any[]) => call("dismiss", ...args)) as any;
api.submitSecret = ((...args: any[]) => call("secret", ...args)) as any;
api.submitUserForm = ((...args: any[]) => call("form", ...args)) as any;
api.dismissUserForm = ((...args: any[]) => call("form-dismiss", ...args)) as any;
api.userFormPrefill = async () => ({});
api.mutateComputerHandoff = ((...args: any[]) => call("handoff", ...args)) as any;
function Fixture() {
  Object.assign(qa, { ready: true });
  const [value, setValue] = useState<any>(null);
  const [generation, setGeneration] = useState(0);
  qa.render = (next) => {
    current = next;
    qa.calls = [];
    qa.result = null;
    qa.fail = false;
    qa.hold = false;
    setValue(next);
    setGeneration((n) => n + 1);
  };
  qa.update = (metadata) => {
    current = {
      ...current,
      message: { ...current.message, metadata },
      approval: current.approval ? { ...current.approval, ...metadata } : undefined,
    };
    setValue(current);
  };
  return (
    <main style={{ maxWidth: 520, margin: "24px auto", padding: 12 }} key={generation}>
      {value?.approval ? (
        <ApprovalCard
          approval={value.approval as ApprovalView}
          onResolve={async (decision, selectedItems) => {
            await call("approval", decision, selectedItems);
          }}
        />
      ) : value?.message ? (
        <RichMessage message={value.message as ChannelMessageView} />
      ) : null}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
