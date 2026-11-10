export type {
  BrowserNetworkView,
  NetworkDevice,
  NetworkSettings,
  NetworkMode,
  NetworkSettingsUpdate,
  NetworkEgress,
  NetworkQuality,
  NetworkConnectivity,
  NetworkFamilyHealth,
  NetworkFamilyState,
} from "@openteam/plugin-sdk/browser-network/protocol";
export { currentConnectivity } from "@openteam/plugin-sdk/browser-network/protocol";
export interface NetworkSharingStatus {
  supported: boolean;
  connected: boolean;
  sharingAllowed: boolean;
  providing: boolean;
  serverUrl: string | null;
  deploymentId: string | null;
  activeConnections: number;
}
