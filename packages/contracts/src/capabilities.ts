/** Product limits enforced by the server and advertised to clients at bootstrap. */
export const CLIENT_CAPABILITIES = {
  uploads: {
    maxAttachmentsPerMessage: 6,
    maxRegularBytes: 25 * 1024 * 1024,
    maxVideoBytes: 200 * 1024 * 1024,
  },
} as const;

export interface ClientCapabilities {
  uploads: {
    maxAttachmentsPerMessage: number;
    maxRegularBytes: number;
    maxVideoBytes: number;
  };
}
