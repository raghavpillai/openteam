/** Host CLI status exposed by the desktop bridge; contains no credentials. */
export interface TailscaleStatus {
  enabled: boolean;
  publicUrl: string;
  backendUrl: string;
  httpsPort: string;
  hostname: string | null;
  route: "matching" | "missing" | "conflict" | "unavailable" | "disabled";
  ownership: "openteam" | "external" | "none";
  issue: string | null;
  verified: boolean;
  managedRoutes: number;
}
export interface DesktopTailscaleStatus {
  canManage: boolean;
  status: TailscaleStatus | null;
  message: string | null;
}
