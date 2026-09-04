import { use } from "react";
import { Streamdown } from "streamdown";
import {
  messageComponents,
  messageUrlTransform,
  botMermaidOptions,
  botShikiTheme,
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
      className="bot-markdown"
      components={messageComponents}
      controls={streamdownControls}
      lineNumbers={false}
      mermaid={botMermaidOptions}
      plugins={plugins}
      shikiTheme={botShikiTheme}
      urlTransform={messageUrlTransform}
    >
      {prepareMessageMarkdown(children)}
    </Streamdown>
  );
}
