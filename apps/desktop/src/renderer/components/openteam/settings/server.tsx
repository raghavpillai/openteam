import { TailscaleSettings } from "./tailscale";
import { ServerActivity } from "./server-activity";

export default function ServerSettings() {
  return (
    <>
      <ServerActivity />
      <TailscaleSettings />
    </>
  );
}
