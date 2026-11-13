import { Switch } from "../../ui/switch";

/** The settings on/off switch: the shared Switch primitive with a label. */
export function InteractiveSwitch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}) {
  return (
    <Switch
      aria-label={label ?? (checked ? "On" : "Off")}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
    />
  );
}

