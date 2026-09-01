export const GROUP_MEMBER_LIMIT = 6;

export const toggleBoundedSelection = <Value>(
  current: readonly Value[],
  value: Value,
  { min = 0, max = Number.POSITIVE_INFINITY }: { min?: number; max?: number } = {}
): readonly Value[] => {
  const index = current.indexOf(value);
  if (index >= 0) {
    if (current.length <= Math.max(0, Math.trunc(min))) return current;
    return current.filter((_candidate, candidateIndex) => candidateIndex !== index);
  }
  if (current.length >= Math.max(0, Math.trunc(max))) return current;
  return [...current, value];
};
