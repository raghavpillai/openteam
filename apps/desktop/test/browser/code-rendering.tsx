import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MessageResponse } from "../../src/renderer/components/ai-elements/message";
import { clearCodeHighlighterCaches, getCodeHighlighterCacheStats } from "../../src/renderer/components/ai-elements/message-response/code";
import "../../src/renderer/styles.css";

const root = createRoot(document.getElementById("root")!);
Object.assign(window, {
  renderMarkdown(source: string) {
    flushSync(() => root.render(<div style={{ width: 900, padding: 20 }}><MessageResponse>{source}</MessageResponse></div>));
  },
  renderCode(source: string | null, language = "typescript") {
    flushSync(() => root.render(source === null ? null : <div style={{ width: "var(--fixture-width, 900px)", padding: 20 }}><MessageResponse>{`\`\`\`${language}\n${source}\n\`\`\``}</MessageResponse></div>));
  },
  clearCodeHighlighterCaches,
  getCodeHighlighterCacheStats,
});
