import { use } from "react";
import { Streamdown } from "streamdown";
import {
  messageComponents,
  messageUrlTransform,
  grokMermaidOptions,
  grokShikiTheme,
  prepareMessageMarkdown,
  streamdownControls,
} from "./message-response-config";
import type { AdvancedMessageCapabilities } from "./message-response-capabilities";
import { loadAdvancedMessagePlugins } from "./message-response-plugins";

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
