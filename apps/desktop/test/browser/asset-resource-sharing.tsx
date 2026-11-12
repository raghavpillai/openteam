import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { clearAuthToken, getAuthCredentialGeneration } from "../../src/renderer/client/auth";
import { useAuthenticatedResource } from "../../src/renderer/hooks/use-authenticated-resource";

const errors: string[] = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
const blobs = new Map<string, number>();
let created = 0;
const create = URL.createObjectURL.bind(URL);
const revoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => {
  const url = create(blob);
  created++;
  blobs.set(url, blob.size);
  return url;
};
URL.revokeObjectURL = (url) => {
  blobs.delete(url);
  revoke(url);
};
let requests = 0;
const requestDetails: Array<{ url: string; generation: number; aborted: boolean }> = [];
let holdRequests = false;
let failuresRemaining = 0;
const held: Array<() => void> = [];
const resourceFailures: string[] = [];
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  if (new URL(String(input), location.href).pathname.startsWith("/api/")) {
    requests++;
    const detail = {
      url: String(input),
      generation: getAuthCredentialGeneration(),
      aborted: false,
    };
    requestDetails.push(detail);
    if (holdRequests)
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          detail.aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (init?.signal?.aborted) {
          abort();
          return;
        }
        init?.signal?.addEventListener("abort", abort, { once: true });
        held.push(() => {
          init?.signal?.removeEventListener("abort", abort);
          if (!detail.aborted) resolve();
        });
      });
    if (failuresRemaining > 0) {
      failuresRemaining--;
      return new Response("Synthetic transient failure", { status: 503 });
    }
  }
  return originalFetch(input, init);
};
function Image({ source, index }: { source: string; index: number }) {
  const url = useAuthenticatedResource(source, {
    onError: (cause) => resourceFailures.push(String(cause)),
  });
  return (
    <img
      data-index={index}
      alt={`Resource ${index}`}
      src={url ?? undefined}
      width={128}
      height={96}
    />
  );
}
const root = createRoot(document.getElementById("root")!);
const render = (sources: string[], keys?: string[]) =>
  flushSync(() =>
    root.render(
      <StrictMode>
        {sources.map((source, index) => (
          <Image key={keys?.[index] ?? index} source={source} index={index} />
        ))}
      </StrictMode>
    )
  );
Object.assign(window, {
  renderAssetResources: render,
  invalidateAssetCredentials: () => flushSync(() => clearAuthToken()),
  holdAssetRequests: (hold: boolean) => {
    holdRequests = hold;
  },
  releaseAssetRequests: () => {
    for (const complete of held.splice(0)) complete();
  },
  transitionAssetFrames: async (sources: string[]) => {
    render(sources);
    const frames = [];
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push(
        [...document.querySelectorAll<HTMLImageElement>("img")].map((image) => ({
          source: image.getAttribute("src"),
          width: image.naturalWidth,
        }))
      );
    }
    return frames;
  },
  failAssetRequests: (count: number) => {
    failuresRemaining = count;
  },
  assetResourceProbe: () => ({
    requests,
    errors,
    resourceFailures,
    requestDetails,
    generation: getAuthCredentialGeneration(),
    created,
    blobCount: blobs.size,
    blobBytes: [...blobs.values()].reduce((sum, bytes) => sum + bytes, 0),
    images: [...document.querySelectorAll<HTMLImageElement>("img")].map((image) => ({
      source: image.getAttribute("src"),
      width: image.naturalWidth,
      height: image.naturalHeight,
    })),
  }),
  unmountAssetResources: () => flushSync(() => root.unmount()),
});
render([]);
