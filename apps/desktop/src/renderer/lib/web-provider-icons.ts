const icons = import.meta.glob<string>("../assets/web-providers/*.webp", { eager: true, import: "default" });

/** A web provider's logo by its brand (see packages/contracts/src/web-search.ts). */
export const webProviderIcon = (brand: string): string | undefined =>
  icons[`../assets/web-providers/${brand}.webp`];
