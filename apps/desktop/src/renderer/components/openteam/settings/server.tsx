import { lazy, Suspense } from "react";
import { TailscaleSettings } from "./tailscale";
import { ServerActivity } from "./server-activity";

const TranscriptionSettingsPanel = lazy(() =>
  import("./transcription").then((module) => ({ default: module.TranscriptionSettingsPanel }))
);

export default function ServerSettings() {
  return (
    <>
      <ServerActivity />
      <Suspense fallback={null}>
        <TranscriptionSettingsPanel />
      </Suspense>
      <TailscaleSettings />
    </>
  );
}
