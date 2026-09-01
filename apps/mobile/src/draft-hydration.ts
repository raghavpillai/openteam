export type DraftField = "text" | "attachments" | "reply";
export type DraftHydrationCheckpoint = Readonly<Record<DraftField, number>>;

export class DraftHydrationGuard {
  private revisions: Record<DraftField, number> = {
    text: 0,
    attachments: 0,
    reply: 0,
  };

  markEdited(field: DraftField): void {
    this.revisions[field] += 1;
  }

  checkpoint(): DraftHydrationCheckpoint {
    return { ...this.revisions };
  }

  isUntouched(checkpoint: DraftHydrationCheckpoint, field: DraftField): boolean {
    return this.revisions[field] === checkpoint[field];
  }
}
