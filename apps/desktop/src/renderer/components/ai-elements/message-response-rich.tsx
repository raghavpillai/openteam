import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown } from "streamdown";

export default function AdvancedMessageResponse({ children }: { children: string }) {
  return (
    <Streamdown
      className="[&_a]:text-blue-600 [&_a]:underline [&_code]:rounded-md [&_code]:bg-black/6 [&_code]:px-1 [&_pre]:overflow-x-auto [&_p]:my-0"
      plugins={{ cjk, code, math, mermaid }}
    >
      {children}
    </Streamdown>
  );
}
