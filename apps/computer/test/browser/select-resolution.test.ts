import { expect, test } from 'bun:test';
import { RESOLVE_THE_ONE_OPTION_A_SECRET_NAMES_FN, resolveReferenceSelectOptions } from '../../src/browser/reference-select';

const option = (value: string, label: string, disabled = false, groupDisabled = false) => ({
  value, label, disabled, matches: (selector: string) => selector === ':disabled' && (disabled || groupDisabled),
});

test('native dropdown exact values win over colliding display labels regardless of order', () => {
  const el = { tagName: 'SELECT', options: [option('first', 'second'), option('second', 'Other choice')] };
  expect(resolveReferenceSelectOptions(el, ['second'])).toMatchObject({ kind: 'matched', values: ['second'], fuzzy: false });
});

test('disabled optgroup choices are not selected by label fallback', () => {
  const el = { tagName: 'SELECT', options: [option('locked', 'Choice', false, true), option('available', 'Choice')] };
  expect(resolveReferenceSelectOptions(el, ['Choice'])).toMatchObject({ kind: 'matched', values: ['available'] });
});


test('empty and fully disabled dropdowns fail unavailable selections without falling back to a long action wait', () => {
  for (const options of [[], [option('locked', 'Choice', true)]]) {
    const el = {tagName: 'SELECT', options};
    expect(resolveReferenceSelectOptions(el, ['Choice'])).toMatchObject({kind: 'unmatched', optionCount: 0});
    expect(resolveReferenceSelectOptions(el, [])).toMatchObject({kind: 'matched', values: []});
  }
});

test('a write-only value resolves to the one native option it names without the model naming it', () => {
  const select = (...options: Array<[string, string] | [string, string, boolean]>) => ({ tagName: 'SELECT',
    options: options.map(([value, label, disabled = false]) => ({ ...option(value, label, disabled), text: label })) });
  const months = select(['', 'Month'], ...Array.from({ length: 12 }, (_, i): [string, string] => [String(i + 1).padStart(2, '0'), `${String(i + 1).padStart(2, '0')} - ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][i]}`]));
  const years = select(['', 'Year'], ...Array.from({ length: 10 }, (_, i): [string, string] => [String(2026 + i), String(2026 + i)]));
  expect(RESOLVE_THE_ONE_OPTION_A_SECRET_NAMES_FN(months, '08/27')).toEqual({ kind: 'matched', value: '08', how: 'expiry-month' });
  expect(RESOLVE_THE_ONE_OPTION_A_SECRET_NAMES_FN(years, '08/27')).toEqual({ kind: 'matched', value: '2027', how: 'expiry-year' });
  expect(RESOLVE_THE_ONE_OPTION_A_SECRET_NAMES_FN(years, '27')).toEqual({ kind: 'matched', value: '2027', how: 'number' });
  const countries = select(['CA', 'Canada'], ['US', 'United States'], ['GB', 'United Kingdom']);
  expect(RESOLVE_THE_ONE_OPTION_A_SECRET_NAMES_FN(countries, 'us')).toEqual({ kind: 'matched', value: 'US', how: 'label' });
  expect(RESOLVE_THE_ONE_OPTION_A_SECRET_NAMES_FN(select(['840', 'United States'], ['124', 'Canada']), 'US')).toEqual({ kind: 'matched', value: '840', how: 'country' });
  expect(RESOLVE_THE_ONE_OPTION_A_SECRET_NAMES_FN(select(['ca', 'California'], ['co', 'Colorado']), 'Calif')).toEqual({ kind: 'matched', value: 'ca', how: 'label' });
  // Two enabled matches, or only disabled ones, leave the dropdown unchanged.
  expect(RESOLVE_THE_ONE_OPTION_A_SECRET_NAMES_FN(select(['a', 'Same'], ['b', 'Same']), 'Same')).toEqual({ kind: 'unmatched' });
  expect(RESOLVE_THE_ONE_OPTION_A_SECRET_NAMES_FN(select(['a', 'Only', true]), 'Only')).toEqual({ kind: 'unmatched' });
  expect(RESOLVE_THE_ONE_OPTION_A_SECRET_NAMES_FN(select(['a', 'Al'], ['b', 'Alaska']), 'Mars')).toEqual({ kind: 'unmatched' });
});
