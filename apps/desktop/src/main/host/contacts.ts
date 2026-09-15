import {
  parsePhoneNumberFromString,
  isSupportedCountry,
  type CountryCode,
} from "libphonenumber-js/max";
import { nativeCommand, type NativeCommand } from "./native-command";

export function normalizeContact(
  contact: { id: string; name: string; phones: string[]; emails: string[] },
  region: string | null
) {
  const phones: string[] = [];
  const unresolvedPhones: string[] = [];
  for (const raw of contact.phones) {
    const number = parsePhoneNumberFromString(
      raw,
      region && isSupportedCountry(region) ? (region as CountryCode) : undefined
    );
    if (number?.isPossible() && !number.ext) phones.push(number.number);
    else unresolvedPhones.push(raw);
  }
  return {
    ...contact,
    phones: [...new Set(phones)],
    emails: [...new Set(contact.emails)],
    ...(unresolvedPhones.length ? { unresolvedPhones } : {}),
  };
}
const script = `ObjC.import('Contacts'); ObjC.import('Foundation'); function run(argv) {
 const input=JSON.parse(argv[0]);const store=$.CNContactStore.alloc.init;const error=Ref();
 const keys=$([$.CNContactIdentifierKey,$.CNContactGivenNameKey,$.CNContactFamilyNameKey,$.CNContactMiddleNameKey,$.CNContactNicknameKey,$.CNContactOrganizationNameKey,$.CNContactPhoneNumbersKey,$.CNContactEmailAddressesKey]);
 const result=[];const seen={};let total=0;
 const region=ObjC.unwrap($.NSLocale.currentLocale.objectForKey($.NSLocaleCountryCode))||null;
 if(input.handles && Number($.CNContactStore.authorizationStatusForEntityType(0))!==3)return JSON.stringify({contacts:[],total:0,region});
 const predicates=input.handles?input.handles.map(handle=>handle.indexOf('@')>=0?$.CNContact.predicateForContactsMatchingEmailAddress($(handle)):$.CNContact.predicateForContactsMatchingPhoneNumber($.CNPhoneNumber.phoneNumberWithString($(handle)))):[$.CNContact.predicateForContactsMatchingName($(input.query))];
 for(const predicate of predicates){const contacts=store.unifiedContactsMatchingPredicateKeysToFetchError(predicate,keys,error);if(!contacts)throw Error('Contacts access unavailable');
  total+=Number(contacts.count);for(let i=0;i<Math.min(Number(contacts.count),201);i++){const c=contacts.objectAtIndex(i);const id=ObjC.unwrap(c.identifier);if(seen[id])continue;seen[id]=true;const phones=[],emails=[];
   for(let j=0;j<Number(c.phoneNumbers.count);j++)phones.push(ObjC.unwrap(c.phoneNumbers.objectAtIndex(j).value.stringValue));
   for(let j=0;j<Number(c.emailAddresses.count);j++)emails.push(ObjC.unwrap(c.emailAddresses.objectAtIndex(j).value));
   const name=[ObjC.unwrap(c.givenName),ObjC.unwrap(c.middleName),ObjC.unwrap(c.familyName)].filter(Boolean).join(' ')||ObjC.unwrap(c.nickname)||ObjC.unwrap(c.organizationName);
   result.push({id,name,phones,emails});}}
 return JSON.stringify({kind:'find-contacts',region,contacts:result.slice(0,200),total,...(total>200?{truncated:'count'}:{})});
}`;
export class NativeContacts {
  constructor(private readonly run: NativeCommand = nativeCommand) {}
  private async query(input: { query?: string; handles?: string[] }, signal?: AbortSignal) {
    const result = JSON.parse(
      await this.run(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", script, JSON.stringify(input)],
        signal
      )
    );
    return {
      ...result,
      contacts: result.contacts.map(({ id: _id, ...contact }: any) => normalizeContact(contact, result.region)),
    };
  }
  find(query: string, signal?: AbortSignal) {
    return this.query({ query }, signal);
  }
  async people(handles: string[], signal?: AbortSignal): Promise<Record<string, string>> {
    const requested = [...new Set(handles)].slice(0, 200);
    if (!requested.length) return {};
    const result = await this.query({ handles: requested }, signal);
    const people: Record<string, string> = {};
    for (const handle of requested) {
      const names = result.contacts
        .filter((contact: any) =>
          [...contact.phones, ...contact.emails].some(
            (value) => value.toLowerCase() === handle.toLowerCase()
          )
        )
        .map((contact: any) => contact.name)
        .filter(Boolean);
      if (names.length) people[handle] = [...new Set(names)].join(" / ");
    }
    return people;
  }
}
