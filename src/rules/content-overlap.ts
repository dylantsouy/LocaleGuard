import type { Page } from 'playwright';
import type { Finding, Snapshot, TextSurface } from '../types.js';
import { inspectInk } from '../browser/ink.js';

// Index line fragments by occupied cells, deduplicating pairs that share multiple cells.
function intersectingLines(surfaces: TextSurface[], width: number) {
  const cells = new Map<string, number[]>();
  const pairs: [TextSurface,TextSurface][] = [];
  let comparisons = 0;
  for (const [index,a] of surfaces.entries()) {
    const ar = a.rect;
    const neighbors = new Set<number>();
    for (let x=Math.floor(Math.max(0,ar.x)/128); x<=Math.floor(Math.min(width,ar.x+ar.width)/128); x++) {
      for (let y=Math.floor(ar.y/48); y<=Math.floor((ar.y+ar.height)/48); y++) {
        const key = x + '/' + y;
        const cell = cells.get(key) ?? [];
        if (cell.length >= 256 || cells.size > 100000) throw Error('Text density exceeds the overlap inspection limit');
        for (const earlier of cell) neighbors.add(earlier);
        cell.push(index);
        cells.set(key,cell);
      }
    }
    for (const earlier of neighbors) {
      if (++comparisons > 250000) throw Error('Overlap candidate budget exceeded');
      const b = surfaces[earlier]!;
      if (a.selector === b.selector) continue;
      const br=b.rect;
      const w=Math.min(ar.x+ar.width,br.x+br.width)-Math.max(ar.x,br.x);
      const h=Math.min(ar.y+ar.height,br.y+br.height)-Math.max(ar.y,br.y);
      const vertical = a.vertical && b.vertical;
      const inline = vertical ? h : w;
      const minInline = vertical ? Math.min(ar.height,br.height) : Math.min(ar.width,br.width);
      if (inline >= Math.max(8, Math.min(18, 0.4*minInline)) && (vertical ? w : h) >= 2.5) pairs.push([a,b]);
      if (pairs.length > 2000) throw Error('Too many candidate text intersections');
    }
  }
  return pairs;
}

export async function contentOverlap(page: Page, snapshot: Snapshot): Promise<Finding[]> {
  const pairs = intersectingLines(snapshot.surfaces, snapshot.width);
  if (!pairs.length && !snapshot.hitControls.length) return [];
  const { findings, probes, limited } = await page.evaluate(({pairs,controls}) => {
    const findings: Finding[] = [];
    const candidates = [];
    const seen = new Map<Element,Set<Element>>();
    const action = 'a[href],button,input,select,textarea,[role=button]';
    const originalY = scrollY, originalX = scrollX;
    function branches(a: Element,b: Element) {
      if (a.contains(b) || b.contains(a) || a.closest(action) && a.closest(action)===b.closest(action)) return;
      let left=a;
      while (left.parentElement && !left.parentElement.contains(b)) left=left.parentElement;
      const parent=left.parentElement;
      if (!parent) return;
      let right=b;
      while (right.parentElement && right.parentElement!==parent) right=right.parentElement;
      // Ignore separately positioned layers, badges and transient UI. Inspect normal-flow peers.
      for (const el of [a,b]) {
        for (let e: Element|null=el; e; e=e.parentElement) {
          const s=getComputedStyle(e);
          if (['fixed','sticky','absolute'].includes(s.position) ||
            e.matches('[hidden],[inert],[aria-hidden=true],[role=tooltip],[role=dialog],[role=status],[data-localeguard-ignore]') ||
            s.visibility!=='visible' || Number(s.opacity)<0.5 || s.clipPath!=='none') return;
        }
      }
      if (seen.get(left)?.has(right) || seen.get(right)?.has(left)) return;
      return {left,right};
    }
    function remember(group: {left:Element;right:Element}) {
      const set=seen.get(group.left) ?? new Set<Element>();
      set.add(group.right); seen.set(group.left,set);
    }
    function line(el:Element,s:TextSurface) {
      const n=el.childNodes[s.child];
      if (!n || n.nodeType!==Node.TEXT_NODE) return;
      const range=document.createRange(); range.selectNodeContents(n);
      return [...range.getClientRects()].filter(r=>r.width && r.height)[s.fragment];
    }
    try {
      for (const [a,b] of pairs) {
        const ea=document.querySelector(a.selector), eb=document.querySelector(b.selector);
        if (!ea || !eb) continue;
        const group=branches(ea,eb);
        if (!group) continue;
        const docY = originalY+Math.max(a.rect.y,b.rect.y);
        if (docY-scrollY < 4 || docY-scrollY > innerHeight-32) window.scrollTo({top:docY-innerHeight/2,behavior:'instant'});
        const ra=line(ea,a), rb=line(eb,b);
        if (!ra || !rb) continue;
        const left=Math.max(0,ra.left,rb.left), top=Math.max(0,ra.top,rb.top);
        const w=Math.min(innerWidth,ra.right,rb.right)-left, h=Math.min(innerHeight,ra.bottom,rb.bottom)-top;
        const vertical = a.vertical && b.vertical;
        const deep = vertical ? h >= 8 && w >= Math.max(5,0.5*Math.min(ra.width,rb.width)) :
          w >= 8 && h >= Math.max(5,0.5*Math.min(ra.height,rb.height));
        if ((vertical ? w : h) < 2.5 || (vertical ? h : w) < 8) continue;
        // Two separated interior samples must paint one participant on top of the other.
        const samples=[0.30,0.70].map(f=>document.elementsFromPoint(left+w*f,top+h/2));
        if (!deep || !samples.every(stack=>stack.some(el=>ea.contains(el)) && stack.some(el=>eb.contains(el)) &&
            (ea.contains(stack[0]!) || eb.contains(stack[0]!)))) {
          const block = (el: Element) => {
            while (el.parentElement && ['inline','contents'].includes(getComputedStyle(el).display)) el = el.parentElement;
            return el;
          };
          const ba = block(ea), bb = block(eb);
          if (ba === bb || ba.contains(bb) || bb.contains(ba) || a.vertical !== b.vertical ||
              ea.closest('sup,sub,ruby,svg') || eb.closest('sup,sub,ruby,svg')) continue;
          const blockA = ba.getBoundingClientRect(), blockB = bb.getBoundingClientRect();
          const protrudes = (r: DOMRect, box: DOMRect) => vertical ?
            r.left < box.left-1 || r.right > box.right+1 : r.top < box.top-1 || r.bottom > box.bottom+1;
          // Tight leading normally lets the font box protrude on both sides.
          // Require a compressed layout track for the geometry-only fallback.
          const compressed = (el: Element, box: DOMRect) =>
            parseFloat(getComputedStyle(el).lineHeight) > (vertical ? box.width : box.height)+1;
          candidates.push({a,b,group,protrudes:(protrudes(ra,blockA) && compressed(ba,blockA)) ||
            (protrudes(rb,blockB) && compressed(bb,blockB))});
          continue;
        }
        const front=ea.contains(samples[0]![0]!)?a:b, back=front===a?b:a;
        findings.push({ruleId:'content-overlap',severity:'warning',selector:back.selector,
          description:'Text from separate layout branches shares a painted area at two interior points.',
          evidence:{otherSelector:front.selector, overlapWidth:Math.round(w),overlapHeight:Math.round(h),
            hitSamples:2, documentX:Math.round(left+scrollX),documentY:Math.round(top+scrollY), mechanism:'text overprint'}});
        remember(group);
      }
      window.scrollTo({left:originalX,top:originalY,behavior:'instant'});
      for (const selector of controls) {
        const e=document.querySelector(selector);
        if (!e) continue;
        const r=e.getBoundingClientRect();
        if (r.width<12 || r.height<12 || r.top<0 || r.bottom>innerHeight) continue;
        const samples=[[.25,.3],[.75,.3],[.5,.5],[.25,.7],[.75,.7]];
        const tops=samples.map(([x,y])=>document.elementFromPoint(r.left+r.width*x!,r.top+r.height*y!));
        const cover=tops[2];
        if (!cover || !tops.every(t=>t && cover.contains(t))) continue;
        const group=branches(e,cover);
        if (!group) continue;
        const color=getComputedStyle(cover).backgroundColor;
        if (!color.startsWith('rgb(')) continue;
        let other=cover, path=CSS.escape(other.localName);
        while (other!==document.documentElement && other.parentElement) {
          if (other.id && document.querySelectorAll('#'+CSS.escape(other.id)).length===1) {path='#'+CSS.escape(other.id)+(other===cover?'':' > '+path); break;}
          const n=Array.prototype.indexOf.call(other.parentElement.children,other)+1;
          path=other===cover?':nth-child('+n+')':':nth-child('+n+') > '+path;
          other=other.parentElement;
        }
        findings.push({ruleId:'content-overlap',severity:'warning',selector,
          description:'An opaque layout element intercepts five interior hit targets of an enabled control.',
          evidence:{otherSelector:path,hitSamples:5,mechanism:'blocked control',background:color}});
        remember(group);
      }
    } finally {window.scrollTo({left:originalX,top:originalY,behavior:'instant'});}
    const remaining = candidates.filter(({group}) => !seen.get(group.left)?.has(group.right) && !seen.get(group.right)?.has(group.left));
    const groups = new Map<Element,number>();
    const groupId = (e: Element) => { if (!groups.has(e)) groups.set(e,groups.size); return groups.get(e)!; };
    const probes = remaining.slice(0,24).map(({a,b,protrudes,group}) => ({
      a,b,protrudes,key:[groupId(group.left),groupId(group.right)].sort().join('/')
    }));
    return {findings,probes,limited:remaining.length>probes.length};
  },{pairs,controls:snapshot.hitControls});
  const seen = new Set<string>();
  for (const probe of probes) {
    if (seen.has(probe.key)) continue;
    const finding = await inspectInk(page, probe.a, probe.b, probe.protrudes);
    if (finding) { findings.push(finding); seen.add(probe.key); }
  }
  if (limited) snapshot.overlapLimit = 'Local ink inspection capped at 24 candidate pairs';
  return findings;
}
