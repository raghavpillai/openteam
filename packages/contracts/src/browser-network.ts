export type {
  BrowserNetworkView,
  NetworkSettings,
  NetworkSettingsUpdate,
  NetworkEgress,
  NetworkQuality,
  NetworkConnectivity,
  NetworkFamilyHealth,
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
