// Computer action names from other computer-use tools, mapped to the action they mean, as the reference does.
const COMPUTER_ACTION_ALIASES = new Map<string, Record<string, unknown>>([
  ["left_click", { action: "click", button: "left" }],
  ["right_click", { action: "click", button: "right" }],
  ["middle_click", { action: "click", button: "middle" }],
  ["double_click", { action: "click", count: 2 }],
  ["doubleClick", { action: "click", count: 2 }],
  ["triple_click", { action: "click", count: 3 }],
  ["mouse_move", { action: "move" }],
  ["left_click_drag", { action: "drag", button: "left" }],
]);
const IMPLIED_FIELDS = ["button", "count"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Outcome =
  | { kind: "unchanged"; value: unknown }
  | { kind: "applied"; value: Record<string, unknown> }
  | { kind: "refused"; message: string };

function normalizeEntry(entry: unknown): Outcome {
  if (!isRecord(entry) || typeof entry.action !== "string") return { kind: "unchanged", value: entry };
  const alias = entry.action;
  const canonical = COMPUTER_ACTION_ALIASES.get(alias);
  if (!canonical) return { kind: "unchanged", value: entry };
  if (canonical.action === "click" && entry.text !== undefined)
    return {
      kind: "refused",
      message: `Computer has no ${alias} action, and click takes no text. Send action "click"; to hold keys during it, set modifiers, e.g. "shift" or "ctrl+shift".`,
    };
  for (const field of IMPLIED_FIELDS) {
    const implied = canonical[field], sent = entry[field];
    if (implied === undefined || sent === undefined) continue;
    if ((typeof sent === "string" || typeof sent === "number") && String(sent).toLowerCase() === String(implied)) continue;
    return {
      kind: "refused",
      message: `Computer has no ${alias} action, and it would mean ${field} ${JSON.stringify(implied)}, not ${JSON.stringify(sent)}. Send action "${canonical.action}" with the ${field} you mean.`,
    };
  }
  return { kind: "applied", value: { ...canonical, ...entry, action: canonical.action } };
}

/** The Computer arguments with aliased actions rewritten, or the refusal for an alias that conflicts with its fields. */
export function applyComputerActionAliases(value: unknown):
  | { kind: "value"; value: unknown }
  | { kind: "refused"; path: Array<string | number>; message: string } {
  if (!isRecord(value)) return { kind: "value", value };
  const followUps = Array.isArray(value.then) ? (value.then as unknown[]) : undefined;
  const outcomes = [value, ...(followUps ?? [])].map(normalizeEntry);
  if (outcomes.every((outcome) => outcome.kind === "unchanged")) return { kind: "value", value };
  const refusedIndex = outcomes.findIndex((outcome) => outcome.kind === "refused");
  const refused = outcomes[refusedIndex];
  if (refused?.kind === "refused")
    return { kind: "refused", path: refusedIndex === 0 ? ["action"] : ["then", refusedIndex - 1, "action"], message: refused.message };
  const [primary, ...rest] = outcomes as Array<Exclude<Outcome, { kind: "refused" }>>;
  const normalized = primary!.kind === "applied" ? primary!.value : value;
  return { kind: "value", value: followUps === undefined ? normalized : { ...normalized, then: rest.map((outcome) => outcome.value) } };
}

/** For a tool host that checks arguments before the tool runs: the rewritten arguments, or the refusal thrown. */
export function computerArgumentsWithAliases(value: unknown): unknown {
  const result = applyComputerActionAliases(value);
  if (result.kind === "refused") throw new Error(`Invalid arguments:\n${result.path.join(".")}: ${result.message}`);
  return result.value;
}
