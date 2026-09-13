import { test, expect } from 'bun:test';
import { externalDraftHtml } from '../src/external-draft';
test('draft HTML preserves prose while escaping active markup and URL delimiters', () => {
 expect(externalDraftHtml('Hello\r\n<script>alert(1)</script>\nSee https://example.com/a?q=1&b=2.')).toBe('<div dir="auto">Hello<br>&lt;script&gt;alert(1)&lt;/script&gt;<br>See <a href="https://example.com/a?q=1&amp;b=2">https://example.com/a?q=1&amp;b=2</a>.</div>');
 expect(externalDraftHtml('(https://example.com/a)')).toBe('<div dir="auto">(<a href="https://example.com/a">https://example.com/a</a>)</div>');
 expect(externalDraftHtml('**Literal prose** javascript:alert(1)')).toBe('<div dir="auto">**Literal prose** javascript:alert(1)</div>');
});
