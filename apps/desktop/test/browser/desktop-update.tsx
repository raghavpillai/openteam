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
const parameters = new URLSearchParams(location.search);
const compact = parameters.has("compact");
declare global {
  interface Window {
    fixture: {
      installs: number;
      downloads: number;
      failDownload: boolean;
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
  failDownload: false,
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
      if (fixture.failDownload) throw new Error("Test download failed");
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
  { Button },
] = await Promise.all([
  import("../../src/renderer/components/openteam/sidebar"),
  import("../../src/renderer/components/openteam/desktop-update-dialog"),
  import("../../src/renderer/components/ui/tooltip"),
  import("../../src/renderer/lib/desktop-update"),
  import("../../src/renderer/components/openteam/settings/updates"),
  import("../../src/renderer/components/ui/button"),
]);
window.fixture.reopen = () => requestDesktopUpdateRestart(state);
const settings = parameters.has("settings");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <DesktopUpdateDialog />
      {settings ? (
        <main className="mx-auto max-w-3xl p-8">
          <UpdatesSettings />
        </main>
      ) : (
        <aside
          className="fixed inset-y-0 left-0 flex flex-col justify-end border-r bg-sidebar"
          data-sidebar-compact={compact}
          style={{ width: compact ? 88 : 280 }}
        >
          <div className="sidebar-account-footer">
            <AccountMenu compact={compact} onOpenSettings={() => {}}>
              <Button
                aria-label="Account: Raghav Pillai"
                id="account"
                className="sidebar-account-button relative w-full rounded-[11px] hover:bg-subtle data-[state=open]:bg-subtle"
                variant="ghost"
              >
                <span className="sidebar-account-avatar">RP</span>
                <span className="sidebar-account-name">Raghav Pillai</span>
              </Button>
            </AccountMenu>
          </div>
        </aside>
      )}
    </TooltipProvider>
  </StrictMode>
);
window.fixture.ready = true;
