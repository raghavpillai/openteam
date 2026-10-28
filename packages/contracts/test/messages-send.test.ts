import { expect, test } from "bun:test";
import { messagesSendRecipient, validateMessageSend } from "../src/messages-send";
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

test("every Messages tool can name its Mac", () => {
  for (const name of ["FindContacts", "FindIMessageChats", "ChatItems", "SearchIMessages", "IMessageActivity", "FetchIMessageAttachment", "SendIMessage", "CheckIMessagePermissions"]) {
    const tool = DESKTOP_CAPABILITY_TOOLS.find((entry) => entry.name === name) as { inputSchema: { properties: Record<string, unknown> } } | undefined;
    expect(tool?.inputSchema.properties.machineId ?? null).not.toBeNull();
  }
  expect(parseReferenceArguments("ChatItems", { chatGuid: "any;-;+1555", machineId: "m-1" })).toEqual({ chatGuid: "any;-;+1555", machineId: "m-1" });
  expect(parseReferenceArguments("CheckIMessagePermissions", { machineId: "m-1" })).toEqual({ machineId: "m-1" });
});
