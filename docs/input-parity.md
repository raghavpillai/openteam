# Message and attachment input policy

Desktop and iOS share their attachment selection policy through `@openteam/contracts/media-input` and `@openteam/product-core/attachments`. Local durable staging and server ingestion validate actual bytes as well as picker metadata.

| Stage | Policy |
| --- | --- |
| Message text | No additional character maximum in SendMessageInput or ComputerSteerRequest; nonempty text or an attachment is required to send. Transport, journal, and model limits still apply. |
| Attachment selection | Six total attachments. Existing attachments consume slots; selection is sliced to remaining capacity before individual file validation. Valid files survive a mixed selection. |
| Regular files | Up to 26,214,400 bytes (25 MiB), inclusive. Empty files are rejected. |
| Video allowance | Up to 209,715,200 bytes (200 MiB), inclusive, for `.m4v`, `.mov`, `.mp4`, `.ogv`, `.webm`, case-insensitively. MIME declarations do not increase the allowance; AVI/MKV use the regular limit. |
| Inline user-image transport | Allows the base64 encoding of a 25 MiB image. The decoder does not silently slice the input array. Public message attachment count remains six. |
| Model image derivatives | The inspected box helper's geometry and encoding loop: normally 1024-pixel long edge for non-WebP, 1 MiB encoded-byte target, progressive 0.8 dimension reductions, and an 8-pixel short-edge floor. Originals remain intact. |
| WebP | The inspected box's no-codec behavior: known 1280×800/1456×840 canvases and within-target images can pass through; tool images pass through without a codec. Strict user-image processing reports an omission when a larger WebP needs an unavailable codec. Active GrokBot server behavior is not established. |
| Read / ExternalRead text | Selected raw content over 100,000 UTF-16 code units is withheld with the paging notice. Line-number prefixes do not count against that threshold. Oversized full files can be read in small ranges. Out-of-range positive offsets report an error; empty files remain readable. |
| Text preview | Display is clipped at 1,500,000 UTF-16 units. The shared lightweight rendering threshold is 200,000 units. Downloaded/stored originals remain complete. |

iOS waits for the attachment menu's native `onDismiss` before presenting Files, Photos, or the camera. Presenting a picker while the menu is dismissing can leave the composer waiting indefinitely.

This policy reproduces verified behavior from Grok Bot desktop 0.47.0 and host 886e13a. It does not establish complete equivalence with the private Temporal harness, GrokBot's native iOS app, every codec, video frame extraction, PDF extraction layout, or compaction. OpenTeam retains its own transport and tool-result wrappers. The server request-body ceiling is 280 MiB, and the durable send journal has a 16 MiB serialized-size guard; neither is proof of GrokBot's ultimate chat limit.

Evidence, native QA, differential checks, and validation caveats are in [the QA record](qa/input-parity-2026-09-14.md).
