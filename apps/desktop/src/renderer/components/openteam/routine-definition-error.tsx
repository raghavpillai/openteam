/** Keep invalid file-authored routines visible without silently executing old instructions. */
export function RoutineDefinitionError({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="px-2 text-[12px] text-destructive">
      This routine is paused because its definition is invalid. {error}
    </p>
  );
}
