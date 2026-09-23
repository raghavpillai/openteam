/** Stable prompt prefixes with delivery-acknowledged, per-epoch change notes. */
export interface PromptSectionSnapshot {
  render: string;
  compactionEpoch: number;
  announcedRender?: string;
}

export interface PromptSectionReceipt {
  name: string;
  epoch: number;
  render: string;
  previous: string;
  next: string;
}

export const SECTION_LABELS: Record<string, string> = {
  memory: "Memory",
  automations: "Routines",
  agent_directory: "Teammates and groups",
  mcp_instructions: "Connector instructions",
  agent_instructions: "Bot-specific instructions",
};

export function parsePromptSections(value: unknown): Record<string, PromptSectionSnapshot> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, PromptSectionSnapshot> = {};
  for (const [name, candidate] of Object.entries(value)) {
    if (!Object.hasOwn(SECTION_LABELS, name) || !candidate || typeof candidate !== "object")
      continue;
    const entry = candidate as PromptSectionSnapshot;
    if (typeof entry.render !== "string" || !Number.isSafeInteger(entry.compactionEpoch)) continue;
    result[name] = {
      render: entry.render,
      compactionEpoch: entry.compactionEpoch,
      ...(typeof entry.announcedRender === "string"
        ? { announcedRender: entry.announcedRender }
        : {}),
    };
  }
  return result;
}

export function preparePromptSections(
  stored: unknown,
  epoch: number,
  live: Record<string, string>
) {
  const snapshots = parsePromptSections(stored);
  const sections: Record<string, string> = {};
  const receipts: PromptSectionReceipt[] = [];
  for (const [name, render] of Object.entries(live)) {
    if (!Object.hasOwn(SECTION_LABELS, name)) throw new Error(`Unknown prompt section ${name}`);
    let snapshot = snapshots[name];
    if (!snapshot || snapshot.compactionEpoch !== epoch) {
      snapshot = { render, compactionEpoch: epoch };
      snapshots[name] = snapshot;
    }
    sections[name] = snapshot.render;
    const previous = snapshot.announcedRender ?? snapshot.render;
    // Connector instructions are refreshed at the next summary, as in Grok's
    // stable-prefix path; they do not produce user-role change notes.
    if (name !== "mcp_instructions" && previous !== render) {
      receipts.push({ name, epoch, render: snapshot.render, previous, next: render });
    }
  }
  return { snapshots, sections, receipts, update: renderPromptSectionUpdates(receipts) };
}

export function acknowledgePromptSections(
  stored: unknown,
  receipts: readonly PromptSectionReceipt[]
) {
  const snapshots = parsePromptSections(stored);
  for (const receipt of receipts) {
    const current = snapshots[receipt.name];
    if (current?.compactionEpoch !== receipt.epoch || current.render !== receipt.render) continue;
    if ((current.announcedRender ?? current.render) !== receipt.previous) continue;
    snapshots[receipt.name] = { ...current, announcedRender: receipt.next };
  }
  return snapshots;
}

export function renderPromptSectionUpdates(
  receipts: readonly PromptSectionReceipt[]
): string | null {
  if (!receipts.length) return null;
  return [
    "<instructions_update>",
    'These parts of your instructions changed since they were rendered. The copy above keeps the earlier version until your context is next summarized. A section marked "(changed lines only)" lists only the lines added (+) or removed (-) relative to that earlier version; any other section is shown in full and replaces it:',
    "",
    receipts.map(renderSectionUpdate).join("\n\n"),
    "</instructions_update>",
  ].join("\n");
}

function renderSectionUpdate({ name, previous, next }: PromptSectionReceipt): string {
  const heading = `## ${SECTION_LABELS[name]}`;
  if (!next) return `${heading}\n(This section is now empty.)`;
  const replacement = `${heading}\n${next}`;
  if (!previous) return replacement;
  const before = previous.split("\n"),
    after = next.split("\n");
  // Match the reference's bounded LCS diff, including deletion-first ties.
  // Large sections and edits longer than a replacement stay full replacements.
  if (before.length * after.length > 250_000) return replacement;
  const lcs = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const edits: string[] = [];
  let i = 0,
    j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) edits.push(`- ${before[i++]}`);
    else edits.push(`+ ${after[j++]}`);
  }
  for (; i < before.length; i++) edits.push(`- ${before[i]}`);
  for (; j < after.length; j++) edits.push(`+ ${after[j]}`);
  return edits.length >= after.length
    ? replacement
    : [`${heading} (changed lines only)`, ...edits].join("\n");
}
