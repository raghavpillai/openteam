/** Bounded, width-specific row geometry. Never retains message bodies. */
export interface VirtualMeasurements {
  width: number | null;
  rows: Map<string, { size: number; version: string | number }>;
}

export const createVirtualMeasurements = (): VirtualMeasurements => ({
  width: null,
  rows: new Map(),
});

export const setVirtualMeasurement = (
  cache: VirtualMeasurements,
  key: string,
  version: string | number,
  size: number
) => {
  const previous = cache.rows.get(key);
  if (previous?.version === version && Math.abs(previous.size - size) < 0.5) return false;
  cache.rows.delete(key);
  cache.rows.set(key, { size, version });
  if (cache.rows.size > 512) {
    const oldest = cache.rows.keys().next().value;
    if (oldest !== undefined) cache.rows.delete(oldest);
  }
  return true;
};

export const setVirtualMeasurementWidth = (cache: VirtualMeasurements, width: number) => {
  if (cache.width === width) return false;
  cache.width = width;
  cache.rows.clear();
  return true;
};
