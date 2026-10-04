import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

export type PluginPolicyDecision = "deny" | "prompt" | "allow";
export type PluginAuthMode = "none" | "token" | "oauth";

export function PluginAuthSelect({
  className,
  onChange,
  value,
}: {
  className: string;
  onChange: (value: PluginAuthMode) => void;
  value: PluginAuthMode;
}) {
  return (
    <Select onValueChange={(next) => onChange(next as PluginAuthMode)} value={value}>
      <SelectTrigger aria-label="Authentication" className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">None</SelectItem>
        <SelectItem value="token">Token or headers</SelectItem>
        <SelectItem value="oauth">OAuth</SelectItem>
      </SelectContent>
    </Select>
  );
}
