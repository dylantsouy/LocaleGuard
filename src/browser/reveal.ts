import type { Page } from 'playwright';
import type { Finding, Snapshot } from '../types.js';

// Force only CSS state. No click, focus event, form change or navigation.
export async function verifyOffscreen(page: Page, snapshot: Snapshot, findings: Finding[]): Promise<Finding[]> {
  const bySelector = new Map(snapshot.candidates.map(c => [c.selector, c]));
  if (!findings.some(f => bySelector.get(f.selector)?.reveal)) return findings;
  const session = await page.context().newCDPSession(page);
  const confirmed = new Set<string>();
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    let budget = 12;
    for (const finding of findings) {
      const probe = bySelector.get(finding.selector)?.reveal;
      if (!probe || budget-- <= 0) continue;
      const { nodeId } = await session.send('DOM.querySelector', { nodeId:root.nodeId, selector:probe.trigger });
      if (!nodeId) continue;
      try {
        await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses:probe.state === 'checked' ? ['checked'] : ['focus','focus-visible'] });
        const visible = await page.waitForFunction(sel => {
          const e = document.querySelector(sel);
          if (!e) return false;
          const r = e.getBoundingClientRect();
          const y = (Math.max(0,r.top) + Math.min(innerHeight,r.bottom)) / 2;
          return r.width > 0 && r.left >= -1 && r.right <= innerWidth+1 && r.top < innerHeight && r.bottom > 0 &&
            e.contains(document.elementFromPoint(r.left+r.width/2,y));
        }, finding.selector, {timeout:550}).then(() => true, () => false);
        if (visible) confirmed.add(finding.selector);
      } finally {
        await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses:[] });
      }
      if (confirmed.has(finding.selector)) {
        const closed = await page.waitForFunction(sel => {
          const r = document.querySelector(sel)?.getBoundingClientRect();
          return r && (r.right <= 0 || r.left >= innerWidth);
        }, finding.selector, { timeout:550 }).then(()=>true,()=>false);
        if (!closed) confirmed.delete(finding.selector);
      }
    }
  } finally { await session.detach(); }
  return findings.filter(f => !confirmed.has(f.selector));
}
