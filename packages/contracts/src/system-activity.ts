/** System-wide readings, not the API process or an individual desktop.
 * In Docker, CPU/RAM describe the Linux host/VM. Disk describes the data filesystem.
 * null means unavailable; it must never be presented as zero usage.
 */
export interface SystemActivityView {
  sampledAt: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
}
