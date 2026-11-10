# Money Set Aside That No One Uses

Use this review to find active funds that may no longer be needed. A dormant fund can
still have an annual renewal, pending charge, or a valid future purpose, so locking is
never automatic.

## Investigation

1. Start from the complete active-fund catalog, not cleared spend rows. Use cleared
   activity only to identify funds with no cleared spend in the last 90 days and created
   at least 90 days ago, so a never-used active fund remains eligible.
2. Treat a `January 1, 1970` or near-epoch last-used timestamp as a never-used signal,
   but validate it against cleared activity rather than relying on a null field.
3. Rank the catalog candidates by inactivity and age, then read live details for no more
   than the ten strongest candidates needed for the five-result output.
4. For each shortlisted fund, read current owner, members, limits, restrictions, lock
   state, pending activity, and recent activity. State the affected people before any
   proposed change.
5. Check at least 13 months when possible for annual or irregular renewals. If the
   historical window is incomplete, report **Reduced coverage** and stay advisory.
6. Ask the owner whether a renewal, project, or employee still depends on the fund.

## Control Proposal

If the owner confirms the fund is no longer needed and there are no pending or expected
charges, propose a lock. Show the exact proposed lock, including the fund, current state,
effect on the affected people, and supported unlock path. Get explicit approval before
acting. Lock it only when the current connection and permission confirm that action is
available, then verify with a fresh read.

## Recommended Output

```text
Finding X: <fund name> appears dormant.
<State when cleared spend last occurred, the coverage period checked, and ask whether a
planned renewal or purchase still depends on the fund.>
Next step: Lock this fund after confirmation, or leave it active for the stated purpose.
```
