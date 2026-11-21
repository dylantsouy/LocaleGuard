import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createFixtureServer } from '../fixtures/site.mjs';

const tarball = resolve(process.argv[2]);
const npm = process.env.npm_execpath || process.argv[3];
if (!npm) throw Error('Run with npm run test:package -- PATH_TO_TGZ');
const cwd = await mkdtemp(join(tmpdir(), 'localeguard-consumer-'));
async function run(exe, args, env = {}) {
  const p = spawn(exe, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore','pipe','pipe'] });
  let output = '';
  for (const stream of [p.stdout,p.stderr]) stream.setEncoding('utf8').on('data', s => { output += s; });
  const [code] = await once(p, 'close');
  return { code, output };
}
function bin(args, env) {
  return process.platform === 'win32'
    ? run('cmd.exe', ['/d','/c','node_modules\\.bin\\localeguard.cmd', ...args], env)
    : run('./node_modules/.bin/localeguard', args, env);
}
const server = createFixtureServer();
try {
  await writeFile(join(cwd,'package.json'), '{"private":true}');
  const installed = await run(process.execPath, [npm, 'install', '--engine-strict','--no-audit','--no-fund',tarball]);
  assert.equal(installed.code, 0, installed.output);
  const help=await bin(['--help']);
  assert.equal(help.code,0); assert.match(help.output, /Scan localized web pages/);
  assert.equal((await bin(['scan','--unknown'])).code, 2);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const config = { pages: [{ name: 'Checkout', baseline: 'en', locales: { en: origin + '/en/checkout', de: origin + '/de/checkout' } }],
    viewports: [{ name: 'phone', width: 390, height: 844 }] };
  await writeFile(join(cwd,'localeguard.config.json'), JSON.stringify(config));
  const emptyCache={ PLAYWRIGHT_BROWSERS_PATH: join(cwd,'empty-cache') };
  const missing = await bin(['scan'], emptyCache);
  assert.equal(missing.code, 2, missing.output);
  assert.match(missing.output, /npx playwright install chromium/);
  console.log('PASS clean install, local bin, help, invalid option, missing-browser recovery');
  const recover=process.argv.includes('--install-browser');
  if(recover) {
    const download=await run(process.execPath,[join(cwd,'node_modules/playwright/cli.js'),'install','chromium'],emptyCache);
    assert.equal(download.code,0,download.output);
    console.log('PASS installed matching Chromium into the previously empty browser cache');
  }
  const scan = await bin(['scan'],recover?emptyCache:undefined);
  assert.equal(scan.code, 1, scan.output);
  const path = /^JSON  (.+)$/m.exec(scan.output)[1].trim();
  const { results,schemaVersion } = JSON.parse(await readFile(path));
  assert.equal(schemaVersion,1);
  assert.ok(results.every(r=>r.scanStatus==='completed'));
  assert.deepEqual(results.map(r => r.issues.length), [0,3]);
  const browser=await chromium.launch({chromiumSandbox:true});
  try {
    const page=await browser.newPage({offline:true});
    await page.goto(pathToFileURL(join(dirname(path),'index.html')).href);
    assert.equal(await page.locator('article').count(),3);
    await page.getByRole('link',{name:'Review candidates and export annotations'}).click();
    assert.deepEqual(await page.locator('select').evaluateAll(fields=>fields.map(f=>f.value)),['','','']);
    assert.ok(await page.locator('img').evaluateAll(async images=>{
      for (const img of images) { img.loading='eager'; await img.decode(); }
      return images.length===6 && images.every(img=>img.naturalWidth===390);
    }));
    const download=page.waitForEvent('download');
    await page.getByRole('button',{name:'Export annotations JSON'}).click();
    const annotations=JSON.parse(await readFile(await (await download).path()));
    assert.deepEqual(annotations.annotations,[]);
    await page.locator('select').first().selectOption('Uncertain');
    const selected=page.waitForEvent('download');
    await page.getByRole('button').click();
    const check=JSON.parse(await readFile(await (await selected).path()));
    assert.deepEqual(check.annotations.map(a=>a.verdict),['Uncertain']);
  } finally { await browser.close(); }
  delete config.pages[0].locales.de;
  await writeFile(join(cwd,'localeguard.config.json'),JSON.stringify(config));
  assert.equal((await bin(['scan'])).code,0);
  console.log('PASS installed Chromium scan, JSON/HTML, original and annotated PNGs, offline review/export, codes 0/1/2, ' + process.platform + ' ' + process.version);
} finally {
  if (server.listening) await new Promise(done => server.close(done));
  await rm(cwd, { recursive: true, force: true });
}
