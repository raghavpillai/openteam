# Desktop re-audit evidence

Compact evidence for
[40-desktop-performance-reaudit.md](../../40-desktop-performance-reaudit.md):

- [`summary.json`](./summary.json) contains exact final metrics, fixture sizes, A/B results,
  build/package inventory, validation totals, and parity outcomes in machine-readable form.
- [`methodology.md`](./methodology.md) records isolation, measurement definitions, comparison rules,
  discarded harness artifacts, and limitations.

The audit used disposable profiles and databases rather than the user's installed OpenBot profile.
Synthetic measurements are labelled separately from production Electron, CUA, CDP, heap-snapshot,
and true end-to-end HTTP measurements.
