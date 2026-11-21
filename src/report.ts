import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Issue, Report, TargetResult } from './types.js';
import { createHash } from 'node:crypto';

function escape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function issueHtml(issue: Issue) {
  const evidence = Object.entries(issue.evidence).map(([key, value]) =>
    `<div><dt>${escape(key)}</dt><dd>${escape(value)}</dd></div>`).join('');
  const image = escape(issue.screenshot);
  return `<article><div><span class="badge ${issue.severity}">${issue.severity}</span> <code>${escape(issue.ruleId)}</code>
    <h3>${escape(issue.description)}</h3><p><code>${escape(issue.selector)}</code></p>
    <dl>${evidence}</dl></div><a href="${image}"><img loading="lazy" src="${image}" alt="Annotated screenshot for ${escape(issue.selector)}"></a></article>`;
}

function targetHtml(result: TargetResult) {
  const count = result.issues.length;
  const state = result.scanStatus ?? (result.status==='ok'?'completed':'failed');
  const label = state+' · '+count+' findings';
  return `<details ${count || result.status === 'failed' ? 'open' : ''}><summary>
    <strong>${escape(result.page)}</strong> · ${escape(result.language)} · ${escape(result.viewport.name)}
    (${result.viewport.width} × ${result.viewport.height}) <span class="count">${label}</span></summary>
    <p class="url">${escape(result.url)}</p>
    ${result.coverage ? '<p>Measured '+result.coverage.measuredElements+' of '+result.coverage.totalElements+' body descendants.</p>' : ''}
    ${(result.coverage?.diagnostics ?? []).map(d=>'<p>'+escape(d.code)+' · '+escape(d.detail)+'</p>').join('')}
    ${result.error ? `<pre>${escape(result.error)}</pre>` : ''}
    ${result.comparison === 'unavailable' ? '<p>Cross-language comparison unavailable for this target.</p>' : ''}
    ${result.issues.map(issueHtml).join('')}</details>`;
}

export function renderHtml(report: Report) {
  const issues = report.results.flatMap(r => r.issues);
  const stats = [
    ['Targets', report.results.length], ['Errors', issues.filter(i => i.severity === 'error').length],
    ['Warnings', issues.filter(i => i.severity === 'warning').length],
    ...['completed','partial','inaccessible','failed'].map(s=>[s,report.results.filter(r=>(r.scanStatus ?? (r.status==='ok'?'completed':'failed'))===s).length]),
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>LocaleGuard scan report</title><style>
*{box-sizing:border-box}body{margin:0;color:#182d31;background:#f5f7f6;font:16px/1.55 system-ui,sans-serif}
main{max-width:1120px;margin:auto;padding:clamp(16px,4vw,48px)}header{border-top:5px solid #217469;padding-top:20px}
h1{margin:0;font-size:clamp(28px,5vw,45px);letter-spacing:-.04em}h2{font-size:22px}h3{font-size:16px;margin:.7em 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px;margin:24px 0}.stats div,details{background:white;border:1px solid #cbd8d5;border-radius:6px}
.stats div{padding:12px 16px}.stats b{display:block;font-size:26px}details{margin-bottom:12px;overflow-wrap:anywhere}summary{cursor:pointer;padding:14px 18px}
.count{color:#365e57;margin-left:10px}.url,details>p,pre{margin:8px 18px 16px}pre{white-space:pre-wrap;color:#933145}
article{border-top:1px solid #d8e1df;padding:18px;display:grid;grid-template-columns:minmax(0,3fr) minmax(160px,2fr);gap:20px}article>div{min-width:0}
img{width:100%;height:auto;border:1px solid #cbd8d5}.badge{font-weight:650;padding:2px 7px;border-radius:4px}.error{background:#ffe7eb;color:#812138}.warning{background:#fff0c9;color:#674800}
dl{margin:12px 0 0;font-size:14px}dl div{display:flex;flex-wrap:wrap;gap:8px}dt{color:#44605a}dd{margin:0;font-family:monospace}code{font-size:.9em}
@media(max-width:650px){article{grid-template-columns:1fr}.count{display:block;margin:4px 0 0}}
</style></head><body><main><header><h1>LocaleGuard scan report</h1></header>
<section class="stats" aria-label="Scan summary">${stats.map(([name, n]) => `<div><b>${n}</b>${name}</div>`).join('')}</section>
<p><a href="review.html">Review candidates and export annotations</a></p><h2>Scan targets</h2>${report.results.map(targetHtml).join('\n')}</main></body></html>`;
}

export function renderReview(issues: Issue[]) {
  const script = `document.querySelector('button').onclick=()=>{
    const annotations=Array.from(document.querySelectorAll('article')).filter(el=>el.querySelector('select').value).map(el=>({
      ...JSON.parse(el.dataset.target),verdict:el.querySelector('select').value,notes:el.querySelector('textarea').value
    }));
    const url=URL.createObjectURL(new Blob([JSON.stringify({schemaVersion:1,reviewer:document.querySelector('input').value,annotations},null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='localeguard-annotations.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    document.querySelector('output').textContent=annotations.length+' annotations exported';
  }`;
  const hash = createHash('sha256').update(script).digest('base64');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'">
    <title>LocaleGuard human review</title><style>body{font:16px/1.45 system-ui;margin:2em auto;max-width:76rem;padding:0 1rem;color:#18342f}
    article{border-top:1px solid #abbab7;padding:1em 0}section{display:flex;gap:1em;flex-wrap:wrap}figure{flex:1 1 20em;margin:0}img{max-width:100%}
    pre{white-space:pre-wrap;overflow-wrap:anywhere}label{display:block;margin:1em 0}textarea{vertical-align:top;width:min(36em,80%)}button{padding:.6em}</style>
    <h1>LocaleGuard human review</h1><p>${issues.length} candidates. Select a verdict for each reviewed case. Export to save your work before closing.</p>
    <label>Reviewer <input autocomplete="off"></label>${issues.map((issue,i) => {
      const {page,language,url,viewport,ruleId,selector,screenshot,originalScreenshot} = issue;
      const id = createHash('sha256').update(JSON.stringify([url,language,viewport,ruleId,selector,issue.evidence,screenshot])).digest('hex');
      const target = {id,page,language,url,viewport,ruleId,selector,screenshot,originalScreenshot};
      return `<article data-target="${escape(JSON.stringify(target))}"><h2>${i+1}. ${escape(page)} · ${escape(language)} · ${escape(viewport.name)} (${viewport.width} × ${viewport.height})</h2>
        <p>${escape(url)}</p><p><code>${escape(ruleId)} · ${escape(selector)}</code></p><p>${escape(issue.description)}</p>
        <section>${[[originalScreenshot,'Original'],[screenshot,'Annotated']].filter(([path])=>path).map(([path,label])=>
          `<figure><figcaption>${label}</figcaption><a href="${escape(path)}"><img loading="lazy" src="${escape(path)}" alt="${label} screenshot"></a></figure>`).join('')}</section>
        <details><summary>DOM, CSS and geometry evidence</summary><pre>${escape(JSON.stringify(issue.evidence,null,2))}</pre></details>
        <label>Verdict <select><option value="">Awaiting review</option>${['True Positive','False Positive','Uncertain','Known False Negative'].map(v=>'<option>'+v+'</option>').join('')}</select></label>
        <label>Notes <textarea rows="2"></textarea></label></article>`;
    }).join('')}<button type="button">Export annotations JSON</button> <output aria-live="polite"></output><script>${script}</script></html>`;
}

export async function writeReport(directory: string, report: Report) {
  await Promise.all([
    writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8'),
    writeFile(join(directory, 'index.html'), renderHtml(report), 'utf8'),
    writeFile(join(directory, 'review.html'), renderReview(report.results.flatMap(t=>t.issues)), 'utf8'),
  ]);
}
