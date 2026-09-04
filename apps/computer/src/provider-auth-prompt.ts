export interface AuthSelectOption {
  id: string;
  label: string;
  description?: string;
}

const normalizedOptionText = (option: AuthSelectOption): string =>
  `${option.id} ${option.label}`.toLowerCase().replace(/[-_]+/g, " ");

export const defaultAuthOption = <Option extends AuthSelectOption>(
  options: readonly Option[]
): Option | undefined =>
  options.find((option) => normalizedOptionText(option).includes("device code")) ?? options[0];

export const authOptionLabel = (option: AuthSelectOption, isDefault: boolean): string => {
  const label = option.label.replace(/\s*\(default\)\s*$/i, "");
  return `${label}${isDefault ? " (default)" : ""}${
    option.description ? ` — ${option.description}` : ""
  }`;
};

export const selectedAuthOption = <Option extends AuthSelectOption>(
  options: readonly Option[],
  answer: string
): Option | undefined => {
  const value = answer.trim();
  if (!value) return defaultAuthOption(options);
  return options[Number(value) - 1] ?? options.find((option) => option.id === value);
};
