import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import type { Page } from 'playwright';
import type { Finding, TextSurface } from '../types.js';

// Isolate the two text runs without reflowing them. Pixel differences are decoded
// in Node so page scripts never receive screenshots of the viewport.
export async function inspectInk(page: Page, a: TextSurface, b: TextSurface, protrudes: boolean): Promise<Finding | undefined> {
  const name = 'lg-' + randomUUID();
  const scroll = await page.evaluate(() => ({left:scrollX, top:scrollY}));
  try {
    const region = await page.evaluate(({a,b,name}) => {
      const runs = [a,b].map(s => {
        const owner = document.querySelector(s.selector);
        const node = owner?.childNodes[s.child];
        if (!owner || node?.nodeType !== Node.TEXT_NODE) return;
        const range = document.createRange();
        range.selectNodeContents(node);
        return {owner,range,index:s.fragment};
      });
      const [first,second] = runs;
      if (!first || !second) return;
      const rect = (run: typeof first) => [...run.range.getClientRects()].filter(r => r.width && r.height)[run.index];
      const initial = rect(first);
      if (!initial) return;
      if (initial.top < 0 || initial.bottom > innerHeight) scrollBy({top:initial.top-innerHeight/2,behavior:'instant'});
      const ra = rect(first), rb = rect(second);
      if (!ra || !rb) return;
      const x = Math.max(0,ra.left,rb.left), y = Math.max(0,ra.top,rb.top);
      const w = Math.min(innerWidth,ra.right,rb.right)-x, h = Math.min(innerHeight,ra.bottom,rb.bottom)-y;
      if (w < 2.5 || h < 2.5) return;
      const css = (el: Element) => {
        const s = getComputedStyle(el);
        return [s.fontFamily,s.fontSize,s.lineHeight,s.writingMode,s.direction].join(' / ');
      };
      CSS.highlights.set(name+'-a', new Highlight(first.range));
      CSS.highlights.set(name+'-b', new Highlight(second.range));
      const left = Math.max(0,Math.floor(x)-2), top = Math.max(0,Math.floor(y)-2);
      return {clip:{x:left,y:top,width:Math.min(512,Math.ceil(x+w)+2-left,innerWidth-left),
        height:Math.min(512,Math.ceil(y+h)+2-top,innerHeight-top)},
        evidence:{documentX:x+scrollX,documentY:y+scrollY,overlapWidth:w,overlapHeight:h,
          firstCSS:css(first.owner),secondCSS:css(second.owner),firstRect:JSON.stringify(ra),secondRect:JSON.stringify(rb)}};
    },{a,b,name});
    if (!region) return;
    const hide = (id: string) => '::highlight('+name+'-'+id+'){color:transparent!important;text-shadow:none!important}';
    const shot = async (style: string) => PNG.sync.read(await page.screenshot({clip:region.clip,style,caret:'hide',scale:'css'}));
    const blank = await shot(hide('a')+hide('b'));
    const onlyA = await shot(hide('b')), onlyB = await shot(hide('a'));
    const stable = blank.data.equals((await shot(hide('a')+hide('b'))).data);
    const differs = (image: PNG, i: number) => [0,1,2].some(c => Math.abs(image.data[4*i+c]! - blank.data[4*i+c]!) >= 24);
    let shared = 0, touching = 0, inkA = 0, inkB = 0;
    for (let i=0; i<blank.width*blank.height; i++) {
      const first = differs(onlyA,i), second = differs(onlyB,i);
      if (first) inkA++;
      if (second) inkB++;
      if (first && second) shared++;
      if (first && ((i % blank.width && differs(onlyB,i-1)) ||
          (i%blank.width+1 < blank.width && differs(onlyB,i+1)) ||
          (i>=blank.width && differs(onlyB,i-blank.width)) ||
          (i+blank.width<blank.width*blank.height && differs(onlyB,i+blank.width)))) touching++;
    }
    const contact = stable && (shared >= 2 || touching >= 2);
    if (stable && !contact && !(protrudes && inkA && inkB)) return;
    return {ruleId:'content-overlap',severity:'warning',selector:a.selector,
      description:contact ? 'Painted text from separate blocks touches in the sampled crop.' :
        'Uncertain: intersecting text fragments need visual review.',
      evidence:{otherSelector:b.selector,mechanism:'shallow text collision',assessment:contact?'ink contact':'uncertain',
        ...region.evidence,sharedPixels:shared,adjacentPixels:touching,firstInkPixels:inkA,secondInkPixels:inkB,
        stableCrop:String(stable),protrudingRange:String(protrudes),cropWidth:blank.width,cropHeight:blank.height}};
  } finally {
    await page.evaluate(({name,scroll}) => {
      CSS.highlights.delete(name+'-a'); CSS.highlights.delete(name+'-b');
      scrollTo({...scroll,behavior:'instant'});
    },{name,scroll});
  }
}
