import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installPerformanceMonitoring } from "./lib/performance";
import "./styles.css";

installPerformanceMonitoring();
document.documentElement.classList.remove("dark");
localStorage.removeItem("openbot:theme");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
