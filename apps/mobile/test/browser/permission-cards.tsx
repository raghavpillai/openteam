import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MobileRichMessageCard } from "../../src/components/rich-message-card";
import { ApprovalCard } from "../../src/components/approval-card";
const qa = {
  calls: [] as unknown[][],
  result: null as any,
  fail: false,
  hold: false,
  release: () => {},
  render: (_value: any) => {},
  update: (_value: any) => {},
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
  if (qa.result?.message) qa.update(qa.result.message.metadata);
  return qa.result ? qa.result.accepted : true;
};
Object.assign(window, {
  mobileFixtureApi: {
    userFormPrefill: async () => ({}),
    submitUserForm: (...args: unknown[]) => call("form", ...args),
    dismissUserForm: (...args: unknown[]) => call("form-dismiss", ...args),
  },
});
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
          approval={value.approval}
          onResolve={async (decision, selectedItems) => {
            await call("approval", decision, selectedItems);
          }}
        />
      ) : value?.message ? (
        <MobileRichMessageCard
          message={value.message}
          readOnly={value.readOnly}
          onWidgetResponse={(answer) => call("widget", "message", answer)}
          onWidgetDismiss={() => call("dismiss", "message")}
          onSecretSubmit={(secret) => call("secret", "message", secret)}
          onComputerHandoff={(action) => call("handoff", "message", action)}
        />
      ) : null}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
