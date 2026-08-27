import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown } from "streamdown";
import {
  messageComponents,
  messageUrlTransform,
  grokMermaidOptions,
  grokShikiTheme,
  prepareMessageMarkdown,
  streamdownControls,
} from "./message-response-config";

const math = createMathPlugin({ singleDollarTextMath: true });

export default function AdvancedMessageResponse({ children }: { children: string }) {
  return (
    <Streamdown
      className="grok-markdown"
      components={messageComponents}
      controls={streamdownControls}
      lineNumbers={false}
      mermaid={grokMermaidOptions}
      plugins={{ cjk, code, math, mermaid }}
      shikiTheme={grokShikiTheme}
      urlTransform={messageUrlTransform}
    >
      {prepareMessageMarkdown(children)}
    </Streamdown>
  );
}
