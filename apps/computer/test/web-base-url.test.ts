import { expect, test } from 'bun:test';
import { webMarkdown } from '../src/builtin-fetch';
const documentUrl = 'https://example.org/news/current/page';
const cases = [
 ['relative directory', '<base href="/archives/2024/">', 'record.html', 'https://example.org/archives/2024/record.html'],
 ['cross-origin base', '<base href="https://data.example.net/releases/">', 'table.csv', 'https://data.example.net/releases/table.csv'],
 ['first href wins', '<base target="_blank"><base href="/first/"><base href="/second/">', 'item', 'https://example.org/first/item'],
 ['invalid first stays fallback', '<base href="http://["><base href="/second/">', 'item', 'https://example.org/news/current/item'],
 ['empty first stays document', '<base href=""><base href="/second/">', 'item', 'https://example.org/news/current/item'],
 ['javascript base rejected', '<base href="javascript:alert(1)">', 'item', 'https://example.org/news/current/item'],
 ['data base rejected', '<base href="data:text/plain,hello">', 'item', 'https://example.org/news/current/item'],
 ['fragment uses base', '<base href="/guide/">', '#chapter', 'https://example.org/guide/#chapter'],
 ['absolute target unchanged', '<base href="/guide/">', 'https://other.example/info', 'https://other.example/info'],
 ['no base unchanged', '', '../source', 'https://example.org/news/source'],
];
for (const [name, head, href, expected] of cases) {
 test(`web extraction URL semantics: ${name}`, () => {
  const result = webMarkdown(`<html><head>${head}</head><body><p>Read <a href="${href}">source</a>.</p></body></html>`, documentUrl);
  expect(result).toContain(`[source](${expected})`);
 });
}
test('base resolution never emits executable or local-file links', () => {
 const result = webMarkdown('<html><head><base href="file:///tmp/"></head><body><p><a href="private.txt">local</a> <a href="javascript:alert(1)">script</a> <a href="https://example.net/ok">public</a></p></body></html>', documentUrl);
 expect(result).not.toContain('file:');
 expect(result).not.toContain('javascript:');
 expect(result).toContain('[public](https://example.net/ok)');
});
