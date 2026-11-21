import type { Page } from 'playwright';
import type { Finding } from '../types.js';

export async function captureFinding(page: Page, finding: Finding, path: string, originalPath: string): Promise<void> {
  const selector = String(finding.evidence.contributingElement ?? finding.selector);
  const marker = await page.evaluateHandle(({ selector, ruleId, owner, collision }) => {
    let el = document.querySelector(selector);
    if (!el) throw new Error('Evidence element disappeared: ' + selector);
    if (ruleId === 'text-clipped' && typeof owner === 'string' && el.getBoundingClientRect().height > innerHeight) {
      el = document.querySelector(owner) ?? el;
    }
    const isDocument = ruleId === 'page-overflow' && selector === 'html';
    if (!isDocument) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const targetY = isDocument ? 0 : (collision?.y ?? window.scrollY + el.getBoundingClientRect().y) - innerHeight / 3;
    window.scrollTo({ top: Math.max(0, targetY), left: 0, behavior: 'instant' });
    const rect = collision ? new DOMRect(collision.x-scrollX,collision.y-scrollY,collision.w,collision.h) : el.getBoundingClientRect();
    const left = isDocument ? innerWidth - 9 : Math.max(0, Math.min(innerWidth - 9, rect.left));
    const top = isDocument ? 0 : Math.max(0, Math.min(innerHeight - 8, rect.top));
    const width = isDocument ? 9 : Math.max(8, Math.min(innerWidth, rect.right) - left);
    const height = isDocument ? innerHeight : Math.max(8, Math.min(innerHeight, rect.bottom) - top);
    const marker = document.createElement('div');
    marker.setAttribute('aria-hidden', 'true');
    marker.style.cssText = 'all:initial!important;position:fixed!important;display:block!important;' +
      'pointer-events:none!important;z-index:2147483647!important;box-sizing:border-box!important;' +
      'border:3px solid #d12445!important;background:rgba(255,40,64,.08)!important;' +
      `left:${left}px!important;top:${top}px!important;width:${width}px!important;height:${height}px!important`;
    return marker;
  }, { selector, ruleId: finding.ruleId, owner: finding.evidence.textSelector,
    collision: typeof finding.evidence.documentY === 'number' ? {
      x: Number(finding.evidence.documentX), y: Number(finding.evidence.documentY),
      w: Number(finding.evidence.overlapWidth), h: Number(finding.evidence.overlapHeight),
    } : undefined });
  try {
    const css = await page.evaluate(selector => {
      const el = document.querySelector(selector);
      if (!el) return;
      const style = getComputedStyle(el);
      return {element:el.localName,position:style.position,display:style.display,overflow:style.overflow,
        writingMode:style.writingMode,lineHeight:style.lineHeight,fontFamily:style.fontFamily,viewportRect:JSON.stringify(el.getBoundingClientRect())};
    },selector);
    Object.assign(finding.evidence,css);
    await page.screenshot({ path: originalPath, type:'png', caret:'hide' });
    await marker.evaluate(el => { document.documentElement.append(el); });
    await page.screenshot({ path, type: 'png', caret: 'hide' });
  } finally {
    await marker.evaluate(el => el.remove()).catch(() => {});
    await marker.dispose();
  }
}
