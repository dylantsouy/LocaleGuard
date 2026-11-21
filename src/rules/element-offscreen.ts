import type { Finding, Snapshot } from '../types.js';

export function elementOffscreen({ width, candidates }: Snapshot): Finding[] {
  const findings: Finding[] = [];
  for (const { selector, rect } of candidates) {
    const left = Math.max(0, -rect.x);
    const right = Math.max(0, rect.x + rect.width - width);
    const outside = Math.min(rect.width, left + right);
    if (outside < 24 || outside < rect.width * 0.25) continue;
    const uncertain = outside === rect.width;
    findings.push({
      ruleId: 'element-offscreen', severity: 'warning', selector,
      description: uncertain ? 'Uncertain: the entire element is outside the horizontal viewport; its intended state needs review.' :
        'A substantial part of this element lies beyond the horizontal viewport.',
      evidence: { elementX: rect.x, elementWidth: rect.width, viewportWidth: width,
        outsidePx: Math.round(outside), visibleWidth: Math.round(rect.width-outside), assessment: uncertain ? 'uncertain' : 'partial exposure',
        edge: left > right ? 'left' : 'right' },
    });
  }
  return findings;
}
