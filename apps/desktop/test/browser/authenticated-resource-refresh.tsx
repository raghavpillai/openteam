import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { API_BASE } from "../../src/renderer/client/http";
import { useAuthenticatedResource } from "../../src/renderer/hooks/use-authenticated-resource";

// Isolated lifecycle regression: no requests leave the fixture.
const requests: { signal?: AbortSignal | null; finish: (status?: number) => void }[] = [];
window.fetch = async (_input, init) => new Promise<Response>((resolve) => {
  requests.push({ signal: init?.signal, finish: (status = 200) => resolve(new Response("frame", { status })) });
});
const revoked = new Set<string>();
const revoke = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url) => { revoked.add(url); revoke(url); };
let current: string | null = null;
function Probe({ source, retainPreviousFor }: { source: string | null; retainPreviousFor?: string }) {
  const url = useAuthenticatedResource(source, { retainPreviousFor });
  useEffect(() => { current = url; }, [url]);
  return <span>{url ?? "loading"}</span>;
}
const root = createRoot(document.getElementById("root")!);
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
const checks: string[] = [];
const check = (ok: unknown, label: string) => {
  if (!ok) throw new Error(label);
  checks.push(label);
};
async function render(bot: string | null, revision = 0, retained = true) {
  root.render(<Probe source={bot ? `${API_BASE}/api/bots/${bot}/screen/frame?r=${revision}` : null}
    retainPreviousFor={retained && bot ? bot : undefined} />);
  await pause();
}
async function finish(status = 200) { requests.at(-1)!.finish(status); await pause(); }
try {
  await render("one");
  check(current === null, "initial request has no previous frame");
  await finish();
  const first = current!;
  check(first?.startsWith("blob:"), "first frame loaded");
  await render("one", 1);
  check(current === first && !revoked.has(first), "same-bot refresh retains a usable blob");
  const superseded = requests.at(-1)!;
  await render("one", 2);
  check(superseded.signal?.aborted && current === first, "rapid refresh aborts stale request without clearing frame");
  superseded.finish();
  await pause();
  check(current === first, "late aborted response cannot replace frame");
  await finish();
  const second = current!;
  check(second !== first && revoked.has(first), "replacement retires previous blob after commit");
  await render("two");
  check(current === null && revoked.has(second), "bot switch immediately clears previous bot frame");
  await finish();
  const third = current!;
  await render(null);
  check(current === null && revoked.has(third), "disabling screen clears and releases frame");
  await render("two");
  await finish();
  await render("two", 1);
  await finish(403);
  check(current === null, "access failure does not retain protected frame");
  await render("asset", 0, false);
  await finish();
  const asset = current!;
  await render("asset", 1, false);
  check(current === null && revoked.has(asset), "ordinary resources still clear while loading");
  await finish();
  const last = current!;
  root.unmount();
  await pause();
  check(revoked.has(last), "unmount releases final blob");
  console.log("RESOURCE_REFRESH_RESULT " + JSON.stringify({ checks }));
} catch (error) {
  console.log("RESOURCE_REFRESH_RESULT " + JSON.stringify({ error: String(error), checks }));
}
