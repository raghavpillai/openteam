---
description: Compare meeting commitments with implementation and verification evidence.
---

Read [Granola workflow conventions](../OPENTEAM.md). Audit implementation gaps
for $ARGUMENTS using the `granola-review` skill. Extract relevant commitments
from meeting notes and compare them with current code, documents, tests, and
available change history within the requested scope.

For each commitment report the source, implementation evidence, verification
evidence, and status: implemented and verified, implemented but unverified,
partial, not found in the inspected scope, superseded, or unresolved. Cite file
locations and meeting references. Absence from a limited search is not proof
that work was never done. Prioritize concrete discrepancies by user impact and
recommend the next check or change. This audit does not authorize fixing the
gaps or creating external tasks unless the user also requested that work.
