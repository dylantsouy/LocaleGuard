import test from 'node:test';
import assert from 'node:assert/strict';
import { pageOverflow } from '../dist/rules/page-overflow.js';
import { textClipped } from '../dist/rules/text-clipped.js';
import { elementOffscreen } from '../dist/rules/element-offscreen.js';
import { localeLayoutShift } from '../dist/rules/locale-layout-shift.js';
import { exitCode } from '../dist/scan.js';
import { renderHtml } from '../dist/report.js';

test('document overflow needs a scrollable root and more than its pixel tolerance', () => {
  const doc = { width: 1200, scrollWidth: 1212, scrollableX: true, candidates: [] };
  assert.deepEqual(pageOverflow(doc), []);
  assert.equal(pageOverflow({ ...doc, scrollWidth: 1213 })[0].evidence.excessPx, 13);
  assert.deepEqual(pageOverflow({ ...doc, scrollWidth: 2400, scrollableX: false }), []);
});

test('text clipping tolerates up to three CSS pixels', () => {
  const clip = { selector: '.title', axis: 'x', overflowPx: 3 };
  assert.deepEqual(textClipped({ clips: [clip] }), []);
  assert.equal(textClipped({ clips: [{ ...clip, overflowPx: 4 }] })[0].ruleId, 'text-clipped');
});

test('element overflow uses both absolute and relative horizontal thresholds', () => {
  const detect = (x, width) => elementOffscreen({ width: 400, candidates: [
    { selector: '#card', rect: { x, y: 900, width, height: 60 } },
  ] });
  assert.deepEqual(detect(0, 410), []);
  assert.deepEqual(detect(30, 400), []);
  assert.equal(detect(-80, 160)[0].evidence.edge, 'left');
  assert.equal(detect(450, 120)[0].evidence.outsidePx, 120);
  assert.deepEqual(detect(0, 160), []);
});

test('dual-axis evidence stays on one clipped label, independent labels survive', () => {
  const first = { selector: '#panel', textSelector: '#first', axis: 'x', overflowPx: 8 };
  const both = textClipped({ clips: [first, { ...first, axis: 'y', overflowPx: 12 }, { ...first, textSelector: '#second' }] });
  assert.equal(both.length, 2);
  assert.equal(both[0].evidence.otherAxis_overflowPx, 12);
  assert.equal(both[1].evidence.textSelector, '#second');
});

const base = { key: 'id:send', kind: 'button/', selector: '#send', lines: 1, rect: { x: 0, y: 0, width: 100, height: 30 } };
const changed = { ...base, lines: 3, rect: { ...base.rect, height: 60 }, overlap: { selector: '#next', width: 40, height: 15 } };
test('comparison requires unambiguous identity, comparable width, line growth and height growth', () => {
  const run = (a, b) => localeLayoutShift(a, b, 'en');
  assert.equal(run([base], [changed])[0].severity, 'warning');
  assert.deepEqual(run([base], [base]), []);
  for (const patch of [
    { key: 'id:other' }, { kind: 'a/' }, { lines: 2 }, { overlap: undefined },
    { rect: { ...changed.rect, width: 120 } }, { rect: { ...changed.rect, height: 42 } },
  ]) assert.deepEqual(run([base], [{ ...changed, ...patch }]), []);
  assert.deepEqual(run([base, base], [changed]), []);
  assert.deepEqual(run([base], [changed, changed]), []);
});

test('exit code gives failed scans priority and leaves warnings reviewable', () => {
  const warning = { status: 'ok', issues: [{ severity: 'warning' }] };
  const error = { status: 'ok', issues: [{ severity: 'error' }] };
  assert.equal(exitCode({ results: [warning] }), 0);
  assert.equal(exitCode({ results: [error] }), 1);
  assert.equal(exitCode({ results: [error, { status: 'failed', issues: [] }] }), 2);
});

test('HTML escapes page-derived selectors, evidence, labels and failure messages', () => {
  const payload = '<img src=x onerror="test()">';
  const html = renderHtml({ results: [{
    page: payload, language: 'en', url: 'http://localhost/', viewport: { name: 'phone', width: 390, height: 844 },
    status: 'failed', comparison: 'unavailable', error: payload,
    issues: [{ ruleId: 'text-clipped', severity: 'error', selector: payload, description: payload,
      evidence: { [payload]: payload }, screenshot: 'screenshots/1-1.png' }],
  }] });
  assert.equal(html.includes(payload), false);
  assert.ok(html.includes('&lt;img src=x onerror=&quot;test()&quot;&gt;'));
  assert.ok(html.includes("default-src 'none'"));
});
