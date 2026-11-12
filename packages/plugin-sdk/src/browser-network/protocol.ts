/** Browser-network wire format. This module is safe to import in renderers. */
export const NETWORK_PROTOCOL = "openteam-browser-network.v1";
export const LEASE_MS = 6_000;
export const RENEW_MS = 2_000;
export const MAX_STREAMS = 64;
export const WINDOW = 128 * 1024;
// v1 peers without a capability advertisement retain the original window.
export const MAX_WINDOW = 256 * 1024;
export const RECONNECT_MAX_MS = 4_000;
export const validWindow = (value: unknown): value is number =>
  value === WINDOW || value === MAX_WINDOW;
export const MAX_DATA = 64 * 1024;
export const MAX_QUEUE = 16 * 1024 * 1024;
export const enum FrameType {
  Control = 0,
  Open = 1,
  Ready = 2,
  Error = 3,
  Data = 4,
  Window = 5,
  Fin = 6,
  Reset = 7,
}
export interface Frame {
  type: FrameType;
  id: number;
  payload: Uint8Array;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value));
export const parseJson = (value: Uint8Array): Record<string, unknown> => {
  const result: unknown = JSON.parse(decoder.decode(value));
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid network message");
  return result as Record<string, unknown>;
};
export function encodeFrame(
  type: FrameType,
  id: number,
  payload: Uint8Array = new Uint8Array()
): Uint8Array {
  const bytes = new Uint8Array(12 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 1);
  view.setUint8(1, type);
  view.setUint32(4, id);
  view.setUint32(8, payload.byteLength);
  bytes.set(payload, 12);
  decodeFrame(bytes);
  return bytes;
}
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.byteLength < 12) throw new Error("Invalid network frame");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(1),
    id = view.getUint32(4),
    size = view.getUint32(8);
  if (
    view.getUint8(0) !== 1 ||
    view.getUint16(2) !== 0 ||
    type > 7 ||
    size !== bytes.byteLength - 12 ||
    size > (type === FrameType.Data ? MAX_DATA : 4096) ||
    (type === FrameType.Control) !== (id === 0) ||
    (type === FrameType.Window && size !== 4) ||
    (type === FrameType.Fin && size !== 0)
  )
    throw new Error("Invalid network frame");
  return { type, id, payload: bytes.subarray(12) };
}
export type NetworkMode = "server" | "device" | "ranked";
export interface NetworkSettings {
  deploymentId: string;
  mode: NetworkMode;
  machineId: string | null;
  revision: number;
  sourceOrder: string[];
}
export interface NetworkRoute extends Omit<NetworkSettings, "mode"> {
  mode: "server" | "device";
  epoch: string;
  available: boolean;
  streamWindow?: number;
}
export interface NetworkSettingsUpdate {
  expectedRevision: number;
  mode: NetworkMode;
  machineId: string | null;
  sourceOrder?: string[];
}
export interface NetworkDevice {
  machineId: string;
  label: string;
  enabled: boolean;
  connected: boolean;
  sharingAllowed: boolean;
  supported: boolean;
  working?: boolean;
}
export interface NetworkEgress {
  epoch: string;
  sourceId: string;
  ip: string;
  location: string;
  checkedAt: string;
}
export interface NetworkQuality extends Pick<NetworkEgress, "epoch" | "sourceId" | "checkedAt"> {
  latencyMs: number;
  downloadMbps: number;
  uploadMbps: number;
  downloadBytes: number;
  uploadBytes: number;
}
export type NetworkFamilyState = "checking" | "working" | "unavailable";
export interface NetworkFamilyHealth {
  state: NetworkFamilyState;
  reason?: "connect_failed" | "tls_failed" | "path_failed";
}
/** Measurements belong to one exit lease, never to a saved device preference. */
export interface NetworkConnectivity {
  epoch: string;
  sourceId: string;
  checkedAt: string | null;
  ipv4: NetworkFamilyHealth;
  ipv6: NetworkFamilyHealth;
}
export function currentConnectivity(
  connectivity: NetworkConnectivity | null | undefined,
  epoch: string | undefined,
  sourceId: string | null
): NetworkConnectivity | undefined {
  return connectivity && connectivity.epoch === epoch && connectivity.sourceId === sourceId
    ? connectivity
    : undefined;
}
export interface BrowserNetworkView {
  settings: NetworkSettings;
  runtime: {
    connectivity?: NetworkConnectivity;
    routeEpoch?: string;
    state:
      | "server"
      | "ready"
      | "applying"
      | "waiting_for_device"
      | "unavailable"
      | "update_required";
    appliedRevision: number | null;
    activeMachineId: string | null;
    activeConnections: number;
    bytesSent: number;
    bytesReceived: number;
    blockedConnections: number;
  };
  devices: NetworkDevice[];
}
export interface OpenTarget {
  host: string;
  port: number;
  epoch: string;
}
export function parseTarget(value: Record<string, unknown>): OpenTarget {
  if (
    Object.keys(value).some((k) => !["host", "port", "epoch"].includes(k)) ||
    typeof value.host !== "string" ||
    !value.host ||
    value.host.length > 253 ||
    /[\s\x00-\x1f\x7f/@?#%\\]/.test(value.host) ||
    !Number.isInteger(value.port) ||
    Number(value.port) < 1 ||
    Number(value.port) > 65535 ||
    typeof value.epoch !== "string" ||
    value.epoch.length > 100
  )
    throw new Error("Invalid network target");
  return { host: value.host, port: Number(value.port), epoch: value.epoch };
}
