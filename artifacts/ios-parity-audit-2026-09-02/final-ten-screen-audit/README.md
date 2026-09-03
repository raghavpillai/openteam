# Final iOS ten-screen visual audit

Each comparison places the supplied reference on the left and the signed Release simulator build on the right. Live account content is not expected to be identical; this audit compares the native screen structure, controls, spacing, typography, surfaces, states, and interaction behavior.

| Screen | Result | Evidence |
| --- | --- | --- |
| 1. Message actions | Matched reaction row, grouped action cards, separators, labels, icons, dimming, and bottom-sheet geometry. | [Side by side](side-by-side/1-message-actions.png) |
| 2. Conversation | Matched leading identity pill, trailing computer control, message alignment, reply metadata, jump control, and composer geometry. | [Side by side](side-by-side/2-chat.png) |
| 3. Dismissed widget | Matched prompt/help hierarchy, two disabled option rows, danger styling, dismissed state, card width, and spacing. | [Side by side](side-by-side/3-widget.png) |
| 4. Internal DM transcript | Matched right-side overlay, source-back-only header, speaker labels/messages, and centered read-only badge. Back restores the source viewport. | [Side by side](side-by-side/4-a2a-readonly.png) |
| 5. Internal DM source | Matched source chat header, A2A activity divider, message cards, replied-message metadata, jump control, and composer. | [Side by side](side-by-side/5-a2a-source.png) |
| 6. Native share sheet | Matched the system-owned share presentation and document payload. Contacts and installed app destinations differ between the physical reference device and simulator by design. | [Side by side](side-by-side/6-share.png) |
| 7. Document preview | Matched the native Quick Look overlay, grabber, close/title/share header, scrollable formatted document, and return path. The live fixture document differs from the reference document. | [Side by side](side-by-side/7-document.png) |
| 8. File attachments | Matched attachment chips, document icon/name/size hierarchy, chat placement, date divider, jump control, and composer. | [Side by side](side-by-side/8-attachments-chat.png) |
| 9. Collapsed home/loading | Matched header controls, loading indicator contract, section row/count/chevron, collapsed state, and empty space. The local cached fixture resolves too quickly to retain the transient loading label in a pixel capture. | [Side by side](side-by-side/9-home-collapsed-loading.png) |
| 10. Expanded home/loading | Matched header controls, expanded section, Bot/group marks, title/preview/time columns, tag, row rhythm, and truncation. Live fixture rows and counts differ. | [Side by side](side-by-side/10-home-expanded-loading.png) |

## Additional appearance validation

- [Light home](light/home.png)
- [Light dense Markdown chat](light/chat.png)
- [All ten comparisons](contact-sheet-all-10.png)

Validation: TypeScript passed, 136 mobile tests passed (803 expectations), the signed Release simulator build succeeded, and its code signature verified.
