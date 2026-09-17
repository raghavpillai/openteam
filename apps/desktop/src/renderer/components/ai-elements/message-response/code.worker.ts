import { getEngineStats, highlightAsync } from "./code-engine";

self.onmessage = async ({ data }) => {
  try {
    const { tokens, bg, fg, rootStyle } = await highlightAsync(data.source, data.language, data.themes);
    const result = { tokens, bg, fg, rootStyle };
    self.postMessage({ id: data.id, result, stats: getEngineStats() });
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
