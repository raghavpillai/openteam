# SheetJS Community Edition

`xlsx-0.20.3.tgz` is a repository-local copy of the official SheetJS
Community Edition 0.20.3 package. The desktop workspace consumes this file
directly so a frozen install does not depend on the availability or future
contents of a remote tarball URL.

- Source: <https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz>
- Retrieved: 2026-08-31
- Size: 2,409,319 bytes
- SHA-256: `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`
- SHA-512 (SRI): `sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==`
- Package name/version: `xlsx@0.20.3`
- License: Apache-2.0; the upstream license is included in the tarball.

SheetJS's official vendoring guide recommends checking this tarball into a
project: <https://docs.sheetjs.com/docs/getting-started/installation/nodejs/#vendoring>.
The SheetJS maintainers also publish MD5
`aac39517149362ea8123d8a303486c3c` for the 0.20.3 tarball in
<https://git.sheetjs.com/sheetjs/sheetjs/issues/3283>. That published value
was used only to verify provenance; `SHA256SUMS` is the repository integrity
record.

To update the package, download the new official version to a temporary path,
verify its published upstream checksum and embedded `package.json`, replace
the tarball, update `SHA256SUMS` and this record, and run
`bun install --frozen-lockfile` after regenerating `bun.lock` intentionally.
