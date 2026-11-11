import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './markdown.js';

test('Markdown escapes HTML, blocks unsafe links and external image requests', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![tracker](https://evil.example/track.png)');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('src="https://'));
});
test('Markdown resolves stable UUID image and resource links', () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  const html = renderMarkdown(`[文档](kb://resource/${id})\n\n![图片](kb://resource/${id})`);
  assert.ok(html.includes(`href="#resource/${id}"`));
  assert.ok(html.includes(`src="/api/resources/${id}/file?inline=1"`));
});
