import { test, expect } from "bun:test";
import { NativeContacts, normalizeContact } from "../../src/main/host/contacts";
test("Contacts formats complete national phones and reports ambiguous values without inventing numbers", () => {
  const contact = {
    id: "fixture",
    name: "Fixture",
    phones: ["(415) 555-0100", "911", "+44 20 7946 0018"],
    emails: ["person@example.test"],
  };
  expect(normalizeContact(contact, "US")).toMatchObject({
    phones: ["+14155550100", "+442079460018"],
    unresolvedPhones: ["911"],
  });
  expect(normalizeContact(contact, null).unresolvedPhones).toContain("(415) 555-0100");
});
test("Contacts names are mapped only to requested exact normalized handles", async () => {
  const contacts = new NativeContacts(async (_file, args) => {
    expect(JSON.parse(args.at(-1)!)).toEqual({ handles: ["+14155550100", "missing@example.test"] });
    return JSON.stringify({
      region: "US",
      contacts: [{ id: "fixture", name: "Fixture Person", phones: ["(415) 555-0100"], emails: [] }],
      total: 1,
    });
  });
  expect(await contacts.people(["+14155550100", "missing@example.test"])).toEqual({
    "+14155550100": "Fixture Person",
  });
});
