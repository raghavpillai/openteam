import { use } from "react";
import { Streamdown } from "streamdown";
import {
  messageComponents,
  messageUrlTransform,
  grokMermaidOptions,
  grokShikiTheme,
  prepareMessageMarkdown,
  streamdownControls,
} from "./config";
import type { AdvancedMessageCapabilities } from "./capabilities";
import { loadAdvancedMessagePlugins } from "./plugins";

export default function AdvancedMessageResponse({
  capabilities,
  children,
}: {
  capabilities: AdvancedMessageCapabilities;
  children: string;
}) {
  const plugins = use(loadAdvancedMessagePlugins(capabilities));
  return (
    <Streamdown
      className="grok-markdown"
      components={messageComponents}
      controls={streamdownControls}
      lineNumbers={false}
      mermaid={grokMermaidOptions}
      plugins={plugins}
      shikiTheme={grokShikiTheme}
      urlTransform={messageUrlTransform}
    >
      {prepareMessageMarkdown(children)}
    </Streamdown>
  );
}
