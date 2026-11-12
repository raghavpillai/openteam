import { createRoot } from "react-dom/client";
import { useState } from "react";
import { setThemePreference } from "../../src/renderer/lib/theme";
import { parsePresentation } from "@openteam/contracts/presentation";
import fixture from "../../../ios/Tests/CoreTests/Fixtures/presentation.json";
import { PresentationView } from "../../src/renderer/components/openteam/presentation/presentation-message";
import "../../src/renderer/styles.css";

function Example() {
  const [hidden, setHidden] = useState(false);
  const [dark, setDark] = useState(false);
  const value = structuredClone(fixture);
  value.blocks[0]!.carousel = hidden ? "hidden" : "auto";
  // Optional verified provider images may be supplied by a QA harness.
  const images = (window as any).__presentationImages as string[] | undefined;
  if (images)
    value.places.forEach((place, index) => Object.assign(place, { imageUrl: images[index] }));
  const mediaImages = (window as any).__presentationMediaImages as string[] | undefined;
  if (mediaImages)
    value.blocks[1]!.items!.forEach((item, index) =>
      Object.assign(item, { imageUrl: mediaImages[index] })
    );
  return (
    <main style={{ maxWidth: 960, margin: "32px auto", padding: 20 }}>
      <nav style={{ display: "flex", gap: 16, marginBottom: 24 }}>
        <button
          onClick={() => {
            setThemePreference(dark ? "light" : "dark");
            setDark(!dark);
          }}
        >
          Switch appearance
        </button>
        <button onClick={() => setHidden(!hidden)}>Toggle route only</button>
      </nav>
      <PresentationView presentation={parsePresentation(value)} />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Example />);
