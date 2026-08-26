import { Streamdown } from "streamdown";

export default function RichMessageResponse({ children }: { children: string }) {
  return (
    <Streamdown className="[&_a]:text-blue-600 [&_a]:underline [&_code]:rounded-md [&_code]:bg-black/6 [&_code]:px-1 [&_pre]:overflow-x-auto [&_p]:my-0">
      {children}
    </Streamdown>
  );
}
