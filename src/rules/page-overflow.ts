import type { Finding, Snapshot } from '../types.js';

export function pageOverflow({ width, scrollWidth, scrollableX, candidates, direction }: Snapshot): Finding[] {
  const excess = scrollWidth - width;
  if (!scrollableX || excess <= Math.max(4, width * 0.01)) return [];
  const evidence: Finding['evidence'] = { viewportWidth: width, documentWidth: scrollWidth, excessPx: excess };
  const contributor = candidates.find(({ rect }) => Math.abs(
    direction === 'rtl' ? -rect.x - excess : rect.x + rect.width - scrollWidth) <= 1);
  if (contributor) evidence.contributingElement = contributor.selector;
  return [{
    ruleId: 'page-overflow', severity: 'error', selector: 'html',
    description: 'The document scrolls horizontally beyond the viewport.',
    evidence,
  }];
}
