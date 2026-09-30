import { expect, test } from 'bun:test';
import { resolveReferenceSelectOptions } from '../../src/browser/reference-select';

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
