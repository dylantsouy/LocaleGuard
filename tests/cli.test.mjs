import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createFixtureServer } from '../fixtures/site.mjs';

const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const example = JSON.parse(await readFile(new URL('../localeguard.config.json', import.meta.url), 'utf8'));
let dir, server, origin;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'localeguard-test-'));
  server = createFixtureServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function cli(config, env = {}) {
  const file = join(dir, 'fixture.json');
  await writeFile(file, typeof config === 'string' ? config : JSON.stringify(config));
  const child = spawn(process.execPath, [entry, 'scan', '--config', file], {
    cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null, stderr);
  const path = /^JSON  (.+)$/m.exec(stdout)?.[1]?.trim();
  const report = path ? JSON.parse(await readFile(path, 'utf8')) : undefined;
  return { code, stderr, stdout, path, report };
}

function fixtureConfig() {
  return JSON.parse(JSON.stringify(example).replaceAll('http://127.0.0.1:4173', origin));
}

test('CLI detects the fixture defects, keeps all controls clean, and reproduces the complete report', async () => {
  const cfg = fixtureConfig();
  const first = await cli(cfg);
  assert.equal(first.code, 1, first.stderr);
  assert.equal(first.report.results.length, 8);
  assert.equal(first.report.schemaVersion, 1);
  for (const target of first.report.results) {
    assert.equal(target.status, 'ok', target.error);
    const ids = target.issues.map(i => i.ruleId + ' ' + i.selector).sort();
    if (target.page === 'Checkout' && target.language === 'de') {
      const expected = ['text-clipped #confirm-order', 'text-clipped #delivery-note'];
      if (target.viewport.name === 'mobile') expected.push('page-overflow html');
      assert.deepEqual(ids, expected.sort());
    } else assert.deepEqual(ids, [], JSON.stringify(target));
    for (const issue of target.issues) {
      assert.equal(issue.url, target.url);
      assert.equal(issue.language, target.language);
      assert.deepEqual(issue.viewport, target.viewport);
      assert.ok(issue.description && Object.keys(issue.evidence).length);
      const png = await readFile(join(dirname(first.path), issue.screenshot));
      assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
      assert.equal(png.readUInt32BE(16), target.viewport.width);
      assert.equal(png.readUInt32BE(20), target.viewport.height);
    }
  }
  const second = await cli(cfg);
  assert.equal(second.code, 1, second.stderr);
  assert.notEqual(first.path, second.path);
  assert.deepEqual(first.report, second.report);

  const browser = await chromium.launch({ chromiumSandbox: true });
  try {
    const ctx = await browser.newContext({ offline: true });
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(join(dirname(first.path), 'index.html')).href);
    assert.equal(await page.locator('article').count(), 5);
    const images = await page.locator('article img').evaluateAll(async imgs =>
      Promise.all(imgs.map(async img => { img.loading = 'eager'; await img.decode(); return img.naturalWidth; })));
    assert.equal(images.length, 5);
    assert.ok(images.every(width => [390, 1280].includes(width)));
    // Inspect pixels from one saved finding to prove the marker survived capture.
    const issue = first.report.results.flatMap(r => r.issues)[0];
    const png = await readFile(join(dirname(first.path), issue.screenshot));
    const marked = await page.evaluate(async base64 => {
      const blob = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(blob.width, blob.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(blob, 0, 0);
      const { data } = ctx.getImageData(0, 0, blob.width, blob.height);
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === 209 && data[i + 1] === 36 && data[i + 2] === 69) count++;
      }
      return count;
    }, png.toString('base64'));
    assert.ok(marked > 50, 'expected the red annotation border');
  } finally { await browser.close(); }
});

test('a healthy fixture returns success and has no issues', async () => {
  const cfg = fixtureConfig();
  cfg.pages = [cfg.pages[0]];
  const result = await cli(cfg);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.report.results.every(r => r.issues.length === 0 && r.status === 'ok'));
});

test('shallow collisions retain local paint evidence while tight typography stays clean', async () => {
  const cfg = fixtureConfig();
  cfg.pages = [{name:'Typography',baseline:'en',locales:{en:origin+'/typography'}}];
  const {report,code,stderr,path} = await cli(cfg);
  assert.equal(code,0,stderr);
  for (const {issues,scanStatus} of report.results) {
    assert.equal(scanStatus,'completed');
    const pairs = issues.map(i=>[i.selector,i.evidence.otherSelector].sort().join('/')).sort();
    assert.deepEqual(pairs,['three','five','eight','cjk','rtl'].map(id=>'#'+id+'-a/#'+id+'-b').sort());
    for (const i of issues) {
      assert.equal(i.ruleId,'content-overlap');
      if (i.evidence.mechanism==='shallow text collision') {
        assert.ok(['ink contact','uncertain'].includes(i.evidence.assessment));
        assert.ok(i.evidence.firstInkPixels && i.evidence.secondInkPixels);
      }
      assert.ok((await readFile(join(dirname(path),i.originalScreenshot))).length);
    }
  }
});

test('CSS reveal contracts, genuine edge defects, painted text and blocked controls across both viewports', async () => {
  const cfg = fixtureConfig();
  cfg.pages = [{name:'Library', baseline:'en', locales:{
    en:origin+'/en/reliability', de:origin+'/de/reliability', ja:origin+'/ja/reliability',
  }}];
  const run=await cli(cfg);
  assert.equal(run.code,1,run.stderr);
  assert.equal(run.report.results.length,6);
  for (const target of run.report.results) {
    assert.equal(target.status,'ok',target.error);
    const items=target.issues;
    assert.deepEqual(items.filter(i=>i.ruleId==='element-offscreen').map(i=>i.selector).sort(),['#lost-heading','#partial','#stranded']);
    assert.equal(items.find(i=>i.selector==='#stranded').evidence.assessment,'uncertain');
    const overlaps=items.filter(i=>i.ruleId==='content-overlap');
    assert.equal(overlaps.filter(i=>i.selector==='#blocked' && i.evidence.hitSamples===5).length,1);
    const text=overlaps.filter(i=>i.evidence.mechanism==='text overprint');
    assert.equal(text.length,target.viewport.name==='mobile'?1:0);
    if (text.length) assert.deepEqual([text[0].selector,text[0].evidence.otherSelector].sort(),['#conditions','#contact']);
    assert.equal(items.filter(i=>i.ruleId==='text-clipped' && i.selector==='#titlebox').length,1);
    assert.equal(items.length,target.viewport.name==='mobile'?6:5);
  }
});

test('field patterns distinguish image replacement, active slide clipping, reflow and collisions', async () => {
  const cfg = fixtureConfig();
  cfg.pages = [{ name: 'Patterns', baseline: 'en', locales: { en: origin + '/en/patterns', de: origin + '/de/patterns' } }];
  cfg.viewports = [cfg.viewports[1]];
  const run = await cli(cfg);
  assert.equal(run.code, 1, run.stderr);
  for (const target of run.report.results) {
    const clips = target.issues.filter(i => i.ruleId === 'text-clipped').map(i => i.evidence.textSelector).sort();
    assert.deepEqual(clips, ['#active', '#late-font', '#subtitle', '#title']);
    const outside = target.issues.filter(i => i.ruleId === 'element-offscreen');
    assert.deepEqual(outside.map(i => i.selector), ['#edge']);
    const shifts = target.issues.filter(i => i.ruleId === 'locale-layout-shift');
    assert.deepEqual(shifts.map(i => [i.selector, i.evidence.overlaps]), target.language === 'en' ? [] : [['#collision','#adjacent']]);
    assert.equal(target.issues.length, 5 + shifts.length);
  }
});

test('a missing baseline reports HTTP failure and still checks the other language', async () => {
  const cfg = fixtureConfig();
  cfg.pages = [cfg.pages[1]];
  cfg.pages[0].locales.en = origin + '/missing';
  cfg.viewports = [cfg.viewports[1]];
  const run = await cli(cfg);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /HTTP 404/);
  const [en, de] = run.report.results;
  assert.equal(en.status, 'failed');
  assert.equal(en.scanStatus,'inaccessible');
  assert.equal(en.coverage.diagnostics[0].code,'http');
  assert.equal(de.status, 'ok');
  assert.equal(de.scanStatus,'partial');
  assert.equal(de.comparison, 'unavailable');
  assert.equal(de.issues.length, 3);
  assert.ok(de.issues.every(i => i.ruleId !== 'locale-layout-shift'));
});

test('resource failures and a bounded prefix retain usable evidence and a 429 stops later visits', async () => {
  let limitedRequests=0;
  const site=createServer((req,res)=>{
    if (req.url==='/limit') { limitedRequests++; res.writeHead(429); return res.end(); }
    if (req.url==='/missing.css') { res.writeHead(404); return res.end(); }
    res.writeHead(200,{'content-type':'text/html'});
    res.end('<link rel="stylesheet" href="/missing.css"><p style="width:24px;white-space:nowrap;overflow:hidden">Clipped heading</p>'+'<i></i>'.repeat(20003));
  });
  site.listen(0,'127.0.0.1'); await once(site,'listening');
  try {
    const base='http://127.0.0.1:'+site.address().port;
    const cfg=fixtureConfig();
    cfg.concurrency=1;
    cfg.pages=[{name:'Bounded',baseline:'en',locales:{en:base+'/large'}},{name:'Limited',baseline:'en',locales:{en:base+'/limit',de:base+'/limit'}}];
    cfg.viewports=cfg.viewports.slice(0,1);
    const {report,code}=await cli(cfg);
    assert.equal(code,2);
    const [partial,first,later]=report.results;
    assert.equal(partial.scanStatus,'partial');
    assert.equal(partial.coverage.measuredElements,4000);
    assert.ok(partial.coverage.totalElements>20000);
    assert.deepEqual([...new Set(partial.coverage.diagnostics.map(d=>d.code))].sort(),['document-limit','resource']);
    assert.ok(partial.issues.some(i=>i.ruleId==='text-clipped'));
    assert.equal(limitedRequests,1);
    for (const t of [first,later]) {
      assert.equal(t.scanStatus,'inaccessible');
      assert.equal(t.coverage.diagnostics[0].code,'rate-limited');
    }
  } finally {await new Promise(resolve=>site.close(resolve));}
});

test('a hanging page reaches its deadline and produces a failed report', async () => {
  const stalled = createServer(() => {});
  stalled.listen(0, '127.0.0.1');
  await once(stalled, 'listening');
  try {
    const cfg = fixtureConfig();
    cfg.timeoutMs = 2000;
    cfg.pages = [{ name: 'Slow', baseline: 'en', locales: { en: 'http://127.0.0.1:' + stalled.address().port } }];
    cfg.viewports = [cfg.viewports[0]];
    const run = await cli(cfg);
    assert.equal(run.code, 2);
    assert.match(run.report.results[0].error, /deadline|timeout/i);
  } finally {
    stalled.closeAllConnections();
    await new Promise(resolve => stalled.close(resolve));
  }
});

test('malformed JSON is a CLI error before scanning', async () => {
  const run = await cli('{');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /Cannot load config/);
  assert.equal(run.report, undefined);
});

test('continuously changing measured text returns an incomplete scan', async () => {
  const moving = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><p id="label" style="width:30px;white-space:nowrap;overflow:hidden">Loading</p>' +
      '<script>setInterval(() => document.querySelector("p").firstChild.appendData("."), 40)</script>');
  });
  moving.listen(0, '127.0.0.1');
  await once(moving, 'listening');
  try {
    const cfg = fixtureConfig();
    cfg.pages = [{ name: 'Changing', baseline: 'en', locales: { en: 'http://127.0.0.1:' + moving.address().port } }];
    cfg.viewports = [cfg.viewports[0]];
    const run = await cli(cfg);
    assert.equal(run.code, 2);
    assert.match(run.report.results[0].error, /did not settle/);
  } finally { await new Promise(resolve => moving.close(resolve)); }
});

test('a successful HTTP response with a non-HTML body is a scan failure', async () => {
  const cfg = fixtureConfig();
  cfg.pages = [{ name: 'Stylesheet', baseline: 'en', locales: { en: origin + '/site.css' } }];
  cfg.viewports = [cfg.viewports[0]];
  const run = await cli(cfg);
  assert.equal(run.code, 2);
  assert.match(run.report.results[0].error, /Expected an HTML document, received text\/css/);
});

test('missing browser installation is recorded for every requested target', async () => {
  const cfg = fixtureConfig();
  const run = await cli(cfg, { PLAYWRIGHT_BROWSERS_PATH: join(dir, 'missing-browser-cache') });
  assert.equal(run.code, 2);
  assert.equal(run.report.results.length, 8);
  assert.ok(run.report.results.every(r => r.status === 'failed' && r.error));
});
