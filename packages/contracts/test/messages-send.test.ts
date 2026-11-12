import { expect, test } from "bun:test";
import { messagesSendRecipient, validateMessageSend, validateMessagesSendFiles, MESSAGES_SEND_MAX_BYTES } from "../src/messages-send";
import { parseReferenceArguments } from "../src/reference-parsers";
import { DESKTOP_CAPABILITY_TOOLS } from "../src/desktop-capabilities";

test("sends accept recent macOS's service-neutral chat GUIDs and name who the card shows", () => {
  for (const chatId of ["any;-;+15555550100", "any;+;chat123456", "iMessage;-;a@b.co", "SMS;-;+15555550100"])
    expect(validateMessageSend({ text: "hi", chatId }).chatId).toBe(chatId);
  for (const bad of [{ text: "hi" }, { text: "hi", to: "Alex" }, { text: "hi", to: "+15555550100", chatId: "any;-;x" }, { text: "hi", chatId: "chat123" }, { text: "", to: "a@b.co" }])
    expect(() => validateMessageSend(bad)).toThrow();
  expect(messagesSendRecipient({ text: "x", to: "+15555550100", recipientName: "Alex" })).toEqual({ label: "Alex", handle: "+15555550100", allowable: true });
  expect(messagesSendRecipient({ text: "x", chatId: "any;-;+15555550100" })).toEqual({ label: "+15555550100", handle: "+15555550100", allowable: false });
  expect(messagesSendRecipient({ text: "x", chatId: "any;+;chat1" })).toEqual({ label: "Group chat", allowable: false });
  // recipientName only travels with a `to` send.
  expect(validateMessageSend({ text: "x", chatId: "any;-;+1555", recipientName: "Alex" }).recipientName).toBeUndefined();
});

test("attachment-only and text-with-file sends survive the public parser and validation", () => {
  for (const text of [undefined, "", "Here is the PDF"]) {
    const input = { to: "+15555550100", attachmentPaths: ["/workspace/report.pdf"], ...(text === undefined ? {} : { text }) };
    expect(validateMessageSend(parseReferenceArguments("SendIMessage", input))).toEqual({ ...input, text: text ?? "" });
  }
  const schema = DESKTOP_CAPABILITY_TOOLS.find(tool => tool.name === "SendIMessage")!.inputSchema as any;
  expect(schema.required).not.toContain("text");
  expect(schema.properties.attachmentPaths.items.pattern).toBe("^/");
  for (const attachmentPaths of [[], ["relative.pdf"], ["https://example.com/f.pdf"], ["/a\0.pdf"], Array(11).fill("/a.pdf"), "file.pdf", [null]]) {
    expect(() => validateMessageSend({ to: "+15555550100", attachmentPaths })).toThrow();
    expect(() => parseReferenceArguments("SendIMessage", { to: "+15555550100", attachmentPaths })).toThrow();
  }
  expect(() => validateMessageSend({ to: "+15555550100" })).toThrow("text or at least one attachment");
});

test("private attachment payloads enforce safe filenames, base64 and a combined byte budget", () => {
  const file = { fileName: "report.pdf", bytesBase64: Buffer.from("%PDF-1.7\nfixture").toString("base64") };
  expect(validateMessagesSendFiles([file])).toEqual([file]);
  expect(validateMessagesSendFiles(undefined)).toEqual([]);
  for (const files of [[], Array(11).fill(file), [{ ...file, fileName: "../secret" }], [{ ...file, fileName: "a\\b" }], [{ ...file, fileName: "a\n.pdf" }], [{ ...file, bytesBase64: "!!!!" }], [{ ...file, bytesBase64: "abc" }], [null]])
    expect(() => validateMessagesSendFiles(files)).toThrow();
  // Exercise a real maximum-size base64 string, including its final padded quantum.
  const full = { ...file, bytesBase64: Buffer.alloc(MESSAGES_SEND_MAX_BYTES).toString("base64") };
  expect(validateMessagesSendFiles([full])).toHaveLength(1);
  expect(() => validateMessagesSendFiles([full, file])).toThrow("25 MiB");
});

test("every Messages tool can name its Mac", () => {
  for (const name of ["FindContacts", "FindIMessageChats", "ChatItems", "SearchIMessages", "IMessageActivity", "FetchIMessageAttachment", "SendIMessage", "CheckIMessagePermissions"]) {
    const tool = DESKTOP_CAPABILITY_TOOLS.find((entry) => entry.name === name) as { inputSchema: { properties: Record<string, unknown> } } | undefined;
    expect(tool?.inputSchema.properties.machineId ?? null).not.toBeNull();
  }
  expect(parseReferenceArguments("ChatItems", { chatGuid: "any;-;+1555", machineId: "m-1" })).toEqual({ chatGuid: "any;-;+1555", machineId: "m-1" });
  expect(parseReferenceArguments("CheckIMessagePermissions", { machineId: "m-1" })).toEqual({ machineId: "m-1" });
});
