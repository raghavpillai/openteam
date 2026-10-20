import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsPanel } from "../../src/renderer/components/openteam/settings/panel";
import { installWindowVisibility } from "../../src/renderer/lib/window-visibility";
import "../../src/renderer/styles.css";

function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open settings</button>
      <SettingsPanel open={open} onOpenChange={setOpen} />
    </>
  );
}
installWindowVisibility();
createRoot(document.getElementById("root")!).render(<Fixture />);
