export interface Viewport {
  name: string;
  width: number;
  height: number;
}

export interface PageSpec {
  name: string;
  baseline: string;
  locales: Record<string, string>;
}

export interface Config {
  pages: PageSpec[];
  viewports: Viewport[];
  outputDir: string;
  concurrency: number;
  timeoutMs: number;
}

export interface Target {
  page: string;
  language: string;
  url: string;
  viewport: Viewport;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementBox {
  selector: string;
  rect: Rect;
  reveal?: { trigger: string; state: 'focus' | 'checked' };
}

export interface TextSurface extends ElementBox {
  fragment: number;
  child: number;
  vertical: boolean;
}

export interface TextClip {
  selector: string;
  textSelector: string;
  axis: 'x' | 'y';
  overflowPx: number;
  clipStart: number;
  clipEnd: number;
  textStart: number;
  textEnd: number;
}

export interface Control extends ElementBox {
  key: string;
  kind: string;
  lines: number;
  overlap?: { selector: string; width: number; height: number };
}

export interface Snapshot {
  measuredElements: number;
  totalElements: number;
  overlapLimit?: string;
  width: number;
  scrollWidth: number;
  scrollableX: boolean;
  direction: string;
  candidates: ElementBox[];
  clips: TextClip[];
  controls: Control[];
  surfaces: TextSurface[];
  hitControls: string[];
}

export type RuleId = 'page-overflow' | 'text-clipped' | 'element-offscreen' | 'locale-layout-shift' | 'content-overlap';

export interface Finding {
  ruleId: RuleId;
  severity: 'error' | 'warning';
  selector: string;
  description: string;
  evidence: Record<string, string | number>;
}

export interface Issue extends Finding, Target {
  screenshot: string;
  originalScreenshot?: string;
}

export type ScanState = 'completed' | 'partial' | 'inaccessible' | 'failed';
export interface Diagnostic {
  code: 'http' | 'rate-limited' | 'redirect' | 'resource' | 'document-limit' | 'rule-budget' |
    'network' | 'timeout' | 'internal' | 'harness' | 'browser' | 'unstable' | 'unsupported' | 'baseline';
  detail: string;
}
export interface TargetResult extends Target {
  status: 'ok' | 'failed';
  scanStatus?: ScanState;
  coverage?: { measuredElements: number; totalElements: number; diagnostics: Diagnostic[] };
  comparison: 'baseline' | 'compared' | 'unavailable';
  issues: Issue[];
  error?: string;
}

export interface Report {
  schemaVersion: 1;
  results: TargetResult[];
}
