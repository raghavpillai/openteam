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

export function PluginPolicySelect({
  disabled,
  label,
  onChange,
  value,
}: {
  disabled: boolean;
  label: string;
  onChange: (value: PluginPolicyDecision) => void;
  value: PluginPolicyDecision;
}) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => onChange(next as PluginPolicyDecision)}
      value={value}
    >
      <SelectTrigger
        aria-label={label}
        className="h-7 rounded-[7px] border-black/[0.07] bg-background px-2 text-[10.5px] shadow-none dark:border-white/[0.09]"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="deny">Deny</SelectItem>
        <SelectItem value="prompt">Ask first</SelectItem>
        <SelectItem value="allow">Allow</SelectItem>
      </SelectContent>
    </Select>
  );
}
