import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthGate } from "./components/openbot/auth-gate";
import { installPerformanceMonitoring } from "./lib/performance";
import { initializeTheme } from "./lib/theme";
import "./styles.css";

installPerformanceMonitoring();
initializeTheme();

const root = document.getElementById("root");
if (!root) throw new Error("OpenBot renderer root is missing");

createRoot(root).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>
);
