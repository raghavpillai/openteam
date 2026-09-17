import { use, useMemo } from "react";
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
const codeComponents = import("./large-code");

export default function AdvancedMessageResponse({
  capabilities,
  children,
}: {
  capabilities: AdvancedMessageCapabilities;
  children: string;
}) {
  const plugins = use(loadAdvancedMessagePlugins(capabilities));
  const { MessagePre } = use(codeComponents);
  const richMessageComponents = useMemo(() => ({ ...messageComponents, pre: MessagePre }), [MessagePre]);
  return (
    <Streamdown
      className="bot-markdown"
      components={richMessageComponents}
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
