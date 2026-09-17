import { StrictMode, useEffect, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { AuthGate } from "./components/openteam/auth-gate";
import { DesktopUpdateDialog } from "./components/openteam/desktop-update-dialog";
import { installPerformanceMonitoring } from "./lib/performance";
import { initializeTheme } from "./lib/theme";
import { installWindowVisibility } from "./lib/window-visibility";
import "./styles.css";

// The signed-out window needs authentication UI, not the transcript, sidebar,
// drag-and-drop engine and workspace state. Load the workspace after auth.
function Workspace() {
  const [loaded, setLoaded] = useState<{ component: ComponentType } | { error: unknown }>();
  useEffect(() => {
    let active = true;
    // Commit as soon as the module resolves. Suspense retries can deliberately
    // retain a just-shown fallback for 300 ms, delaying the workspace bootstrap.
    void import("./App").then(
      ({ default: component }) => { if (active) setLoaded({ component }); },
      (error: unknown) => { if (active) setLoaded({ error }); }
    );
    return () => { active = false; };
  }, []);
  if (loaded && "error" in loaded) throw loaded.error;
  if (!loaded) return <div className="grid h-dvh place-items-center text-sm text-foreground-secondary" role="status">Loading workspace…</div>;
  const App = loaded.component;
  return <App />;
}

installPerformanceMonitoring();
initializeTheme();
const disposeVisibility = installWindowVisibility();
if (import.meta.hot) import.meta.hot.dispose(disposeVisibility);

const root = document.getElementById("root");
if (!root) throw new Error("OpenTeam renderer root is missing");

createRoot(root).render(
  <StrictMode>
    <Toaster closeButton position="bottom-right" richColors theme="system" />
    <DesktopUpdateDialog />
    <AuthGate>
      <Workspace />
    </AuthGate>
  </StrictMode>
);
