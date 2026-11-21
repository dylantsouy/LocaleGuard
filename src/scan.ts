import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Config, Control, Diagnostic, Finding, Report, ScanState, Target, TargetResult } from './types.js';
import { measure } from './browser/measure.js';
import { captureFinding } from './browser/screenshot.js';
import { verifyOffscreen } from './browser/reveal.js';
import { contentOverlap } from './rules/content-overlap.js';
import { pageOverflow } from './rules/page-overflow.js';
import { textClipped } from './rules/text-clipped.js';
import { elementOffscreen } from './rules/element-offscreen.js';
import { localeLayoutShift } from './rules/locale-layout-shift.js';
import { writeReport } from './report.js';

interface Job {
  index: number;
  target: Target;
  baseline: string;
  group: number;
}

function message(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes("Executable doesn't exist")) return 'Chromium is missing. Run npx playwright install chromium from the project using LocaleGuard.';
  return detail;
}

export class ScanProblem extends Error {
  constructor(readonly code: Diagnostic['code'], readonly state: ScanState, detail: string) { super(detail); }
}

function failure(target: Target, error: unknown): TargetResult {
  const detail = message(error);
  const problem = error instanceof ScanProblem ? error :
    new ScanProblem(detail.includes('Chromium is missing') ? 'browser' : 'internal', 'failed', detail);
  return { ...target, status: 'failed', scanStatus:problem.state, comparison: 'unavailable', issues: [], error:detail,
    coverage:{measuredElements:0,totalElements:0,diagnostics:[{code:problem.code,detail}]} };
}

type PreparePage = (page: Page, target: Target) => Promise<void | { navigationFailure: () => ScanProblem | undefined }>;

async function scanTarget(browser: Browser, job: Job, controls: Control[] | undefined, dir: string, timeoutMs: number,
    stopped: Set<string>, preparePage?: PreparePage) {
  const { target } = job;
  const context = await browser.newContext({
    viewport: { width: target.viewport.width, height: target.viewport.height },
    locale: target.language, deviceScaleFactor: 1, reducedMotion: 'reduce',
    acceptDownloads: false, serviceWorkers: 'block', permissions: [],
  });
  context.setDefaultTimeout(timeoutMs);
  let timer: NodeJS.Timeout | undefined;
  let loaded = false;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ScanProblem('timeout',loaded?'failed':'inaccessible',`Target exceeded its ${timeoutMs} ms deadline`)), timeoutMs);
    });
    return await Promise.race([inspect(context), deadline]);
  } finally {
    clearTimeout(timer);
    await context.close();
  }

  async function inspect(ctx: BrowserContext) {
    const page = await ctx.newPage();
    ctx.on('page', extra => { if (extra !== page) void extra.close().catch(() => {}); });
    await ctx.route('**/*', route => {
      const url = new URL(route.request().url());
      if (stopped.has(url.origin)) return route.abort();
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return route.abort();
      return route.continue();
    });
    const diagnostics: Diagnostic[] = [];
    const resources = new Map<string,string>();
    function resource(type:string, url:string, reason:string) {
      if (type === 'stylesheet' || type === 'font') resources.set(type+' '+url,reason);
    }
    page.on('requestfailed', req => resource(req.resourceType(), req.url(), req.failure()?.errorText ?? 'request failed'));
    page.on('response', res => {
      if (res.status() === 429) stopped.add(new URL(res.url()).origin);
      if (res.status() >= 400) resource(res.request().resourceType(), res.url(), 'HTTP '+res.status());
    });
    let prepared;
    try { prepared = await preparePage?.(page, target); }
    catch (error) { throw error instanceof ScanProblem ? error : new ScanProblem('harness','failed',message(error)); }
    const response = await page.goto(target.url, { waitUntil: 'load' }).catch(error => {
      throw prepared?.navigationFailure() ?? new ScanProblem(error.name==='TimeoutError'?'timeout':'network','inaccessible',message(error));
    });
    if (!response || !response.ok()) throw new ScanProblem(response?.status()===429?'rate-limited':'http',
      'inaccessible',`Navigation failed: HTTP ${response?.status() ?? 'no response'}`);
    loaded = true;
    if (!['http:', 'https:'].includes(new URL(page.url()).protocol)) throw new Error('Unsupported final URL');
    const mime = response.headers()['content-type']?.split(';')[0]?.trim().toLowerCase();
    if (mime && mime !== 'text/html' && mime !== 'application/xhtml+xml') {
      throw new ScanProblem('unsupported','inaccessible',`Expected an HTML document, received ${mime}`);
    }
    const snapshot = await stableSnapshot(page);
    const overflow = pageOverflow(snapshot);
    const contributor = overflow[0]?.evidence.contributingElement;
    const shifts = controls ? localeLayoutShift(controls, snapshot.controls, job.baseline) : [];
    let overprints: Finding[] = [];
    try { overprints = await contentOverlap(page, snapshot); }
    catch (error) {
      if (!/Text density exceeds|Overlap candidate budget|Too many candidate text intersections/.test(message(error))) throw error;
      snapshot.overlapLimit = message(error);
    }
    if (snapshot.overlapLimit) diagnostics.push({code:'rule-budget',detail:snapshot.overlapLimit});
    if (snapshot.measuredElements < snapshot.totalElements) diagnostics.push({code:'document-limit',
      detail:'Inspected the first '+snapshot.measuredElements+' body descendants in DOM order. Later elements were skipped.'});
    const offscreen = await verifyOffscreen(page, snapshot, elementOffscreen(snapshot).filter(f => f.selector !== contributor));
    const findings = [
      ...overflow, ...textClipped(snapshot), ...offscreen, ...shifts,
      ...overprints.filter(f => !shifts.some(s =>
        (s.selector === f.selector && s.evidence.overlaps === f.evidence.otherSelector) ||
        (s.selector === f.evidence.otherSelector && s.evidence.overlaps === f.selector))),
    ];
    const result: TargetResult = {
      ...target, status: 'ok', issues: [],
      comparison: target.language === job.baseline ? 'baseline' : controls ? 'compared' : 'unavailable',
    };
    for (const [i, finding] of findings.entries()) {
      const screenshot = `screenshots/${job.index + 1}-${i + 1}.png`;
      const originalScreenshot = screenshot.replace('.png','-original.png');
      await captureFinding(page, finding, join(dir, screenshot), join(dir, originalScreenshot));
      result.issues.push({ ...target, ...finding, screenshot, originalScreenshot });
    }
    for (const [key,reason] of [...resources].sort()) diagnostics.push({code:'resource',detail:key+' ('+reason+')'});
    const missingFonts = await page.evaluate(() => [...document.fonts].filter(f => f.status==='error').map(f => f.family).sort());
    for (const family of missingFonts) diagnostics.push({code:'resource',detail:'FontFace failed: '+family});
    if (result.comparison === 'unavailable') diagnostics.push({code:'baseline',detail:'No complete baseline for cross-language measurements'});
    result.scanStatus = diagnostics.length ? 'partial' : 'completed';
    result.coverage = {measuredElements:snapshot.measuredElements,totalElements:snapshot.totalElements,diagnostics};
    return { result, controls: snapshot.controls };
  }
}

async function stableSnapshot(page: Page) {
  const until = performance.now() + 2000;
  let previous: string | undefined;
  do {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const snapshot = await page.evaluate(measure);
    const signature = JSON.stringify(snapshot);
    if (signature === previous) return snapshot;
    previous = signature;
    await sleep(200);
  } while (performance.now() < until);
  throw new ScanProblem('unstable','failed','Layout measurements did not settle within 2000 ms');
}

export async function scan(config: Config, preparePage?: PreparePage): Promise<{ directory: string; report: Report }> {
  await mkdir(config.outputDir, { recursive: true });
  const directory = await mkdtemp(join(config.outputDir, 'scan-'));
  await mkdir(join(directory, 'screenshots'));
  const jobs: Job[] = [];
  let group = 0;
  for (const page of config.pages) {
    for (const viewport of config.viewports) {
      for (const [language, url] of Object.entries(page.locales)) {
        jobs.push({ index: jobs.length, baseline: page.baseline, group, target: { page: page.name, language, url, viewport } });
      }
      group++;
    }
  }
  const results: TargetResult[] = [];
  const timings = jobs.map(job => ({...job.target,ms:0}));
  const stopped = new Set<string>();
  const baselines = new Map<number, Control[]>();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ chromiumSandbox: true, timeout: config.timeoutMs });
    const run = async (job: Job) => {
      const start = performance.now();
      try {
        if (stopped.has(new URL(job.target.url).origin)) throw new ScanProblem('rate-limited','inaccessible','Origin stopped after HTTP 429');
        const outcome = await scanTarget(browser!, job, baselines.get(job.group), directory, config.timeoutMs, stopped, preparePage);
        results[job.index] = outcome.result;
        if (job.target.language === job.baseline && outcome.result.scanStatus === 'completed') baselines.set(job.group, outcome.controls);
      } catch (error) {
        results[job.index] = failure(job.target, error);
      } finally { timings[job.index]!.ms = Math.round(performance.now()-start); }
    };
    for (const baselineWave of [true, false]) {
      const pending = jobs.filter(job => (job.target.language === job.baseline) === baselineWave).values();
      const worker = async () => { for (const job of pending) await run(job); };
      await Promise.all(Array.from({ length: Math.min(config.concurrency, jobs.length) }, worker));
    }
  } catch (error) {
    for (const job of jobs) results[job.index] ??= failure(job.target, error);
  } finally {
    await browser?.close();
  }
  const report: Report = { schemaVersion: 1, results };
  await writeReport(directory, report);
  await writeFile(join(directory,'timings.json'),JSON.stringify(timings,null,2)+'\n');
  return { directory, report };
}

export function exitCode(report: Report): number {
  if (report.results.some(result => result.status === 'failed' || result.scanStatus === 'partial')) return 2;
  return report.results.some(result => result.issues.some(issue => issue.severity === 'error')) ? 1 : 0;
}
