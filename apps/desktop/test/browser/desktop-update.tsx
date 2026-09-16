import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../src/renderer/styles.css";
if (window.openteam) throw new Error("Synthetic fixture requires an isolated window");
window.fetch = async () => {
  throw new Error("Network disabled in update fixture");
};
window.open = () => null;
const listeners = new Set<(status: OpenTeamUpdateStatus) => void>();
let state: OpenTeamUpdateStatus = {
  currentVersion: "0.46.0",
  latestVersion: "0.47.0",
  status: "available",
  progress: null,
  message: null,
  failureKind: null,
  track: "stable",
  downloadUrl: "https://example.invalid",
};
declare global {
  interface Window {
    fixture: {
      installs: number;
      downloads: number;
      failInstall: boolean;
      ready?: boolean;
      emit: (next: Partial<OpenTeamUpdateStatus>) => void;
      snapshot: () => OpenTeamUpdateStatus;
      reopen?: () => void;
    };
  }
}
// All native update calls are synthetic. No release is downloaded or installed.
const fixture = (window.fixture = {
  installs: 0,
  downloads: 0,
  failInstall: false,
  emit(next: Partial<OpenTeamUpdateStatus>) {
    state = { ...state, ...next };
    for (const listener of listeners) listener(state);
  },
  snapshot() {
    return state;
  },
});
window.openteam = {
  versions: { app: "0.46.0" },
  updates: {
    status: async () => state,
    check: async () => state,
    onClientProgress(listener: (status: OpenTeamUpdateStatus) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async openDownload() {
      fixture.downloads++;
      fixture.emit({ status: "downloading", progress: 42 });
    },
    async installClient() {
      fixture.installs++;
      if (fixture.failInstall) throw new Error("Test restart failed");
      fixture.emit({ status: "installing" });
    },
    async serverStatus() {
      return {
        currentVersion: "0.46.0",
        apiProtocolVersion: 1,
        status: "idle",
        updateMethod: "local",
      };
    },
    onServerProgress() {
      return () => {};
    },
  },
} as unknown as NonNullable<Window["openteam"]>;
const [
  { AccountMenu },
  { DesktopUpdateDialog },
  { TooltipProvider },
  { requestDesktopUpdateRestart },
  { default: UpdatesSettings },
] = await Promise.all([
  import("../../src/renderer/components/openteam/sidebar"),
  import("../../src/renderer/components/openteam/desktop-update-dialog"),
  import("../../src/renderer/components/ui/tooltip"),
  import("../../src/renderer/lib/desktop-update"),
  import("../../src/renderer/components/openteam/settings/updates"),
]);
window.fixture.reopen = () => requestDesktopUpdateRestart(state);
const settings = new URLSearchParams(location.search).has("settings");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <DesktopUpdateDialog />
      {settings ? (
        <main className="mx-auto max-w-3xl p-8">
          <UpdatesSettings />
        </main>
      ) : (
        <div style={{ position: "fixed", left: 24, bottom: 24 }}>
          <AccountMenu onOpenAbout={() => {}} onOpenSettings={() => {}}>
            <button
              id="account"
              className="size-9 rounded-full bg-[#282828] text-sm text-[#a0a0a0]"
            >
              RP
            </button>
          </AccountMenu>
        </div>
      )}
    </TooltipProvider>
  </StrictMode>
);
window.fixture.ready = true;
