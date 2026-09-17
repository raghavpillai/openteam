import { expect, test } from "bun:test";
import { getExampleNumber, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";
import examples from "libphonenumber-js/examples.mobile.json";
import { normalizeContact } from "../../src/main/host/contacts";

test("compact contact metadata preserves normalization across every bundled country example", () => {
  for (const country of Object.keys(examples) as CountryCode[]) {
    const example = getExampleNumber(country, examples)!;
    const inputs = [example.number, example.formatNational(), example.formatInternational(), `${example.number} ext. 12`, example.number.slice(0, -5), `${example.number}123456789`, "123"];
    const expected = inputs.map(value => parsePhoneNumberFromString(value, country));
    const phones = [...new Set(expected.filter(value => value?.isPossible() && !value.ext).map(value => value!.number))];
    const unresolved = inputs.filter((_, index) => !expected[index]?.isPossible() || expected[index]?.ext);
    expect(normalizeContact({ id: "fixture", name: country, phones: inputs, emails: [] }, country)).toEqual({
      id: "fixture", name: country, phones, emails: [], ...(unresolved.length ? { unresolvedPhones: unresolved } : {}),
    });
  }
});
