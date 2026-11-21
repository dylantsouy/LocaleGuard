import type { Finding, Snapshot } from '../types.js';

export function textClipped({ clips }: Snapshot): Finding[] {
  const findings = new Map<string, Finding>();
  for (const { selector, ...metrics } of clips) {
    if (metrics.overflowPx <= 3) continue;
    const key = JSON.stringify([selector, metrics.textSelector]);
    const first = findings.get(key);
    if (first) {
      for (const [name, value] of Object.entries(metrics)) first.evidence['otherAxis_' + name] = value;
    } else {
      findings.set(key, { ruleId: 'text-clipped', severity: 'error', selector,
        description: 'Rendered text extends beyond its clipping container.', evidence: metrics });
    }
  }
  return [...findings.values()];
}
