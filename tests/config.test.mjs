import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { validateConfig } from '../dist/config.js';

function config() {
  return {
    pages: [{ name: 'Store', baseline: 'en', locales: { en: 'https://example.org/shop' } }],
    viewports: [{ name: 'phone', width: 390, height: 844 }],
  };
}

test('config defaults and relative output paths use the config directory', () => {
  const result = validateConfig(config(), 'my-project');
  assert.equal(result.outputDir, resolve('my-project/localeguard-reports'));
  assert.equal(result.concurrency, 2);
  assert.equal(result.timeoutMs, 30000);
});

const invalid = [
  ['file URL', c => { c.pages[0].locales.en = 'file:///etc/hosts'; }, /HTTP/],
  ['embedded credentials', c => { c.pages[0].locales.en = 'http://u:p@example.org/'; }, /credentials/],
  ['non-absolute URL', c => { c.pages[0].locales.en = '/en'; }, /URL/],
  ['missing baseline', c => { c.pages[0].baseline = 'es'; }, /baseline/],
  ['invalid language tag', c => { c.pages[0].locales['en!'] = 'http://localhost/'; }, /language tag/],
  ['empty pages', c => { c.pages = []; }, /non-empty/],
  ['duplicate page name', c => c.pages.push(c.pages[0]), /unique/],
  ['duplicate viewport name', c => c.viewports.push(c.viewports[0]), /unique/],
  ['invalid dimension', c => { c.viewports[0].width = 1.5; }, /width/],
  ['unbounded concurrency', c => { c.concurrency = 9; }, /concurrency/],
  ['unbounded timeout', c => { c.timeoutMs = 0; }, /timeoutMs/],
  ['misspelled field', c => { c.timeOutMs = 12000; }, /Unknown field/],
];
for (const [description, change, expected] of invalid) {
  test(`config rejects ${description}`, () => {
    const c = config();
    change(c);
    assert.throws(() => validateConfig(c, '.'), expected);
  });
}
