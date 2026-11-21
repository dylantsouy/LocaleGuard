import type { Control, Finding } from '../types.js';

function uniqueControls(controls: Control[]) {
  const result = new Map<string, Control | null>();
  for (const control of controls) result.set(control.key, result.has(control.key) ? null : control);
  return result;
}

export function localeLayoutShift(baseline: Control[], localized: Control[], baselineLanguage: string): Finding[] {
  const reference = uniqueControls(baseline);
  const findings: Finding[] = [];
  for (const [key, current] of uniqueControls(localized)) {
    const base = reference.get(key);
    if (!base || !current || base.kind !== current.kind || base.lines !== 1 || current.lines < 3) continue;
    if (base.overlap || !current.overlap) continue;
    if (Math.abs(base.rect.width - current.rect.width) > base.rect.width * 0.1) continue;
    if (current.rect.height < base.rect.height * 1.6 || current.rect.height - base.rect.height < 16) continue;
    findings.push({
      ruleId: 'locale-layout-shift', severity: 'warning', selector: current.selector,
      description: 'The translated control wraps to at least three lines and newly overlaps an adjacent control.',
      evidence: { key, baselineLanguage, baselineLines: base.lines, lines: current.lines,
        baselineHeight: base.rect.height, height: current.rect.height,
        baselineWidth: base.rect.width, width: current.rect.width, overlaps: current.overlap.selector,
        overlapWidth: current.overlap.width, overlapHeight: current.overlap.height },
    });
  }
  return findings;
}
