import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WINDOW_ACTIVITY_EVENT, WINDOW_VISIBILITY_EVENT } from "../lib/window-visibility";
import { ScreenBotApp } from "./screenbot-app";
import { refreshScreenBotTheme } from "./theme";
import "./screenbot.css";

refreshScreenBotTheme();
// The shared voice-note wave and orb pause while their window isn't the active one; the
// main window learns that from its bridge, the overlay from its own focus.
const publishActivity = () => {
  window.dispatchEvent(new Event(WINDOW_VISIBILITY_EVENT));
  window.dispatchEvent(new Event(WINDOW_ACTIVITY_EVENT));
};
window.addEventListener("focus", publishActivity);
window.addEventListener("blur", publishActivity);
document.addEventListener("visibilitychange", publishActivity);

const root = document.getElementById("screenbot-root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ScreenBotApp />
    </StrictMode>
  );
}
