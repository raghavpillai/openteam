import { appendDraftAttachment } from "./file-transfer-providers";
export interface ExternalFile {
  assetId: string;
  name: string;
  mimeType: string;
  bytes: Buffer;
}
export async function deliverExternalFiles(
  provider: string,
  token: string,
  target: string,
  content: string,
  files: ExternalFile[],
  fetcher: typeof fetch = fetch
) {
  const privateFetch: typeof fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ) => {
    try {
      return await fetcher(input, init);
    } catch {
      throw new Error(
        "External file provider connection failed; inspect the destination before retrying"
      );
    }
  }) as typeof fetch;
  if (
    !files.length ||
    files.length > 10 ||
    files.some((file) => file.bytes.length > 64 * 1024 * 1024)
  )
    throw new Error("External delivery requires 1–10 files of at most 64 MiB each");
  const json = async (url: string, body: unknown, form = false) => {
    const response = await privateFetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
      },
      body: form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new Error(
        `External file delivery failed (${response.status}); inspect the destination before retrying`
      );
    let result: any;
    try {
      result = await response.json();
    } catch {
      throw new Error(
        "External file provider returned an invalid response; inspect the destination before retrying"
      );
    }
    if (result.ok === false)
      throw new Error(`External file delivery refused: ${String(result.error).slice(0, 100)}`);
    return result;
  };
  if (provider === "slack") {
    if (!/^[CGD][A-Z0-9]+$/.test(target))
      throw new Error("Slack file delivery requires an exact channel ID");
    const staged: Array<{ id: string; title: string }> = [];
    for (const file of files) {
      const upload = await json(
        "https://slack.com/api/files.getUploadURLExternal",
        { filename: file.name, length: String(file.bytes.length) },
        true
      );
      const url = new URL(upload.upload_url);
      if (url.origin !== "https://files.slack.com")
        throw new Error("Slack returned an invalid upload URL");
      const response = await privateFetch(url, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(file.bytes),
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`Slack file staging failed (${response.status})`);
      staged.push({ id: upload.file_id, title: file.name });
    }
    const result = await json("https://slack.com/api/files.completeUploadExternal", {
      files: staged,
      channel_id: target,
      initial_comment: content,
    });
    return {
      sent: true,
      files: (result.files ?? staged).map((file: any) => ({ id: file.id })),
      channel: target,
    };
  }
  if (provider === "gmail") {
    if (!/^[^\s@<>,;:\r\n]+@[^\s@<>,;:\r\n]+\.[^\s@<>,;:\r\n]+$/.test(target))
      throw new Error("Gmail file delivery requires one exact recipient email");
    let mime: Buffer = Buffer.from(
      `To: ${target}\r\nSubject: Files from OpenTeam\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(content).toString("base64")}\r\n`
    );
    for (const file of files)
      mime = appendDraftAttachment(mime, file.name, file.mimeType, file.bytes);
    if (mime.length > 25 * 1024 * 1024) throw new Error("Email with attachments exceeds 25 MiB");
    const result = await json("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      raw: mime.toString("base64url"),
    });
    return { sent: true, messageId: result.id, threadId: result.threadId };
  }
  throw new Error("This connected service has no native file delivery adapter");
}
