# Third-party notices

The OpenTeam connector and adapted skills are project-authored code. `wacli` binaries are from `openclaw/wacli` v0.26.0 at commit `535a8b969cc83c3aad57f66be77e8fd4a7fcaaa3`, under the MIT license reproduced in `LICENSE`. They contain upstream Go dependencies, including whatsmeow, libsignal, and SQLite; their licenses and notices are retained in `THIRD-PARTY-NOTICES.txt`.

The reference skill under `upstream/extensions/whatsapp/skills/wacli/SKILL.md` is from `openclaw/openclaw` at `c321c038b59c1e67f4729023b5e680d3c061c9ca`. Its MIT license is unchanged at `upstream/LICENSE`. It is a source reference; OpenTeam loads the adapted skills declared in `plugin.json`.

QR images are encoded locally with `qrcode-generator` 2.0.4 by Kazuhiko Arase, under the MIT license reproduced in `QR-LICENSE`. No pairing material is sent to an external QR renderer.

WhatsApp and its trademarks belong to their respective owners. This integration is unaffiliated with WhatsApp or Meta.
