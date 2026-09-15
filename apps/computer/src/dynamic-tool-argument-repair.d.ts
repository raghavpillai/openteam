export function parseArgumentsLeniently(blob: string): {
  args: Record<string, unknown>;
  repaired: boolean;
  envelopeFields?: Record<string, string>;
} | undefined;
