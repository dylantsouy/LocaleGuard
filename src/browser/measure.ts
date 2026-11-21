import type { Control, ElementBox, Rect, Snapshot, TextClip } from '../types.js';

// Playwright serializes this function into Chromium. Keep its runtime dependencies local.
export function measure(): Snapshot {
  const root = document.documentElement;
  const body = document.body;
  if (!body) throw new Error('Document has no body');
  const all = body.getElementsByTagName('*');
  const totalElements = all.length;
  const measuredElements = totalElements > 20_000 ? 4000 : totalElements;
  // Bounded DOM-order prefix on oversized documents. Exclude descendants beyond the cutoff.
  const prefix = measuredElements < totalElements ? new Set(Array.from({ length: measuredElements }, (_, i) => all[i]!)) : undefined;
  const styles = new Map<Element, CSSStyleDeclaration>();
  function style(el: Element) {
    let value = styles.get(el);
    if (!value) {
      value = getComputedStyle(el);
      styles.set(el, value);
    }
    return value;
  }

  const visibility = new Map<Element, boolean>();
  function included(el: Element): boolean {
    const cached = visibility.get(el);
    if (cached !== undefined) return cached;
    const css = style(el);
    const customClip = css.clipPath !== 'none' || (css.clip && css.clip !== 'auto');
    const tinyMask = el instanceof HTMLElement && css.overflowX === 'hidden' && css.overflowY === 'hidden' &&
      el.offsetWidth <= 1 && el.offsetHeight <= 1;
    const closedDetails = el.parentElement instanceof HTMLDetailsElement && !el.parentElement.open &&
      el !== el.parentElement.querySelector(':scope > summary');
    const excluded = closedDetails || el.matches('[hidden], [inert], [aria-hidden="true" i], [data-localeguard-ignore], script, style, template, noscript') ||
      css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' ||
      css.contentVisibility === 'hidden' || Number(css.opacity) === 0 || customClip || tinyMask;
    const value = !excluded && (!el.parentElement || included(el.parentElement));
    visibility.set(el, value);
    return value;
  }

  const idCounts = new Map<string, number>();
  if (!prefix) for (const el of document.querySelectorAll('[id]')) idCounts.set(el.id, (idCounts.get(el.id) ?? 0) + 1);
  const selectors = new Map<Element, string>();
  const siblingIndices = new Map<Element, number>();
  function selector(el: Element): string {
    const cached = selectors.get(el);
    if (cached) return cached;
    if (el.id && (idCounts.get(el.id) === 1 || (prefix && document.getElementById(el.id)===el))) return '#' + CSS.escape(el.id);
    const tag = CSS.escape(el.localName);
    if (!el.parentElement) return tag;
    if (!siblingIndices.has(el)) {
      const counts = new Map<string, number>();
      for (const sibling of el.parentElement.children) {
        const index = (counts.get(sibling.localName) ?? 0) + 1;
        counts.set(sibling.localName, index);
        siblingIndices.set(sibling, index);
        if (prefix?.has(el) && !prefix.has(sibling)) break;
      }
    }
    const index = siblingIndices.get(el)!;
    const path = selector(el.parentElement) + ' > ' + tag + ':nth-of-type(' + index + ')';
    selectors.set(el, path);
    return path;
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  function box(el: Element): Rect {
    const r = el.getBoundingClientRect();
    return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
  }
  const scrolling = document.scrollingElement ?? root;
  const width = root.clientWidth || window.innerWidth;
  const rootOverflow = style(root).overflowX === 'visible' ? style(body).overflowX : style(root).overflowX;
  const snapshot: Snapshot = {
    measuredElements, totalElements,
    width, scrollWidth: scrolling.scrollWidth, scrollableX: !['hidden', 'clip'].includes(rootOverflow), direction: style(scrolling).direction,
    candidates: [], clips: [], controls: [], surfaces: [], hitControls: [],
  };
  const clipGroups = new Map<string, Partial<Record<'x' | 'y', TextClip>>>();
  const actionSelector = 'button, a[href], [role="button"], [role="link"]';
  function replacedText(owner: Element, fragments: DOMRect[]) {
    const css = style(owner);
    const indent = parseFloat(css.textIndent);
    const bg = css.backgroundImage !== 'none';
    if (bg && css.height === '0px' && parseFloat(css.paddingTop) > 0 && css.overflowY === 'hidden') return true;
    if (!indent || !fragments.length) return false;
    const r = owner.getBoundingClientRect();
    if (!fragments.every(f => f.left >= r.right - 1 || f.right <= r.left + 1)) return false;
    if (bg || (indent < -100 && r.width <= 1)) return true;
    return indent < -100 && ['::before', '::after'].some(pseudo => {
      const icon = getComputedStyle(owner, pseudo);
      return icon.display !== 'none' && !['none', 'normal'].includes(icon.content);
    });
  }
  // A masked row may show only the first few intact panels (for example a carousel).
  // Only suppress text that fits its own panel and has an adjacent same-row panel.
  function insideMaskedPanel(owner: Element, mask: Element, text: DOMRect): boolean {
    for (let panel: Element | null = owner; panel && panel !== mask; panel = panel.parentElement) {
      if (style(panel).display === 'inline') continue;
      const r = panel.getBoundingClientRect();
      if (text.left < r.left - 1 || text.right > r.right + 1) continue;
      for (const neighbor of [panel.previousElementSibling, panel.nextElementSibling]) {
        if (!neighbor || !included(neighbor)) continue;
        const n = neighbor.getBoundingClientRect();
        if (n.width && n.height && Math.min(r.bottom, n.bottom) > Math.max(r.top, n.top) &&
            (n.left >= r.right - 1 || n.right <= r.left + 1)) return true;
      }
    }
    return false;
  }
  // Inline fragments on one line can have different top edges when fonts differ.
  const lineBands = new Map<Element, Map<number, number>>();
  function countLines(bands: Map<number, number>) {
    let lines = 0;
    let bottom = -Infinity;
    for (const [top, end] of [...bands].sort((a, b) => a[0] - b[0])) {
      if (top >= bottom - 1) lines++;
      bottom = Math.max(bottom, end);
    }
    return lines;
  }
  function* textNodes() {
    if (prefix) {
      for (const el of [body, ...prefix]) {
        for (const child of el.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) yield child;
          if (child instanceof Element && !prefix.has(child)) break;
        }
      }
    } else {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) yield node;
    }
  }
  for (const node of textNodes()) {
    const owner = node.parentElement;
    if (!owner || !node.textContent?.trim() || !included(owner)) continue;
    const action = owner.closest(actionSelector);
    const tracked = action && (action.id || action.hasAttribute('data-localeguard-key'));
    // Stop at the first containing box that clips or scrolls each axis.
    const bounds: Partial<Record<'x' | 'y', HTMLElement>> = {};
    const done = new Set<'x' | 'y'>();
    for (let el: Element | null = owner; el && el !== root && el !== body && done.size < 2; el = el.parentElement) {
      if (!(el instanceof HTMLElement)) continue;
      const css = style(el);
      if (css.display === 'inline' || css.display === 'contents') continue;
      for (const axis of ['x', 'y'] as const) {
        if (done.has(axis)) continue;
        const overflow = axis === 'x' ? css.overflowX : css.overflowY;
        if (overflow === 'visible') continue;
        done.add(axis);
        const intentional = axis === 'x' ? css.textOverflow.includes('ellipsis') : Number(css.webkitLineClamp) > 0;
        const railMask = axis === 'x' && el.matches('[aria-roledescription="carousel" i]');
        if (!intentional && !railMask && (overflow === 'hidden' || overflow === 'clip')) bounds[axis] = el;
      }
    }
    const readable = owner instanceof HTMLElement && !!owner.closest('a, button, label, p, address, li, dt, dd, h1, h2, h3, h4, h5, h6, [role="button"]');
    if (!readable && !tracked && !bounds.x && !bounds.y) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
    if (replacedText(owner, rects)) continue;
    if (readable && style(owner).color !== 'rgba(0, 0, 0, 0)') {
      for (const [fragment, r] of rects.entries()) {
        if (r.right <= 0 || r.left >= width || r.width < 8 || r.height < 6) continue;
        snapshot.surfaces.push({ selector: selector(owner), child: Array.prototype.indexOf.call(owner.childNodes, node),
          fragment, vertical: style(owner).writingMode !== 'horizontal-tb',
          rect: { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) } });
      }
    }
    const rail = owner.closest('[aria-roledescription="carousel" i]');
    if (rail && style(rail).overflowX !== 'visible') {
      const mask = rail.getBoundingClientRect();
      const localBox = (bounds.x ?? bounds.y ?? owner).getBoundingClientRect();
      if (localBox.right <= mask.left || localBox.left >= mask.right) continue;
    }
    if (tracked) {
      const bands = lineBands.get(action) ?? new Map<number, number>();
      for (const r of rects) bands.set(r.top, Math.max(r.bottom, bands.get(r.top) ?? -Infinity));
      lineBands.set(action, bands);
    }
    for (const axis of ['x', 'y'] as const) {
      const clipper = bounds[axis];
      if (!clipper || !rects.length) continue;
      const box = clipper.getBoundingClientRect();
      const scale = axis === 'x' ? box.width / clipper.offsetWidth : box.height / clipper.offsetHeight;
      if (!Number.isFinite(scale)) continue;
      const start = axis === 'x' ? box.left + clipper.clientLeft * scale : box.top + clipper.clientTop * scale;
      const end = start + (axis === 'x' ? clipper.clientWidth : clipper.clientHeight) * scale;
      for (const rect of rects) {
        const textStart = axis === 'x' ? rect.left : rect.top;
        const textEnd = axis === 'x' ? rect.right : rect.bottom;
        const overflow = round(Math.max(start - textStart, textEnd - end));
        if (overflow <= 3) continue;
        if (axis === 'x' && insideMaskedPanel(owner, clipper, rect)) continue;
        let block = owner;
        while (block !== clipper && block.parentElement && style(block).display === 'inline') block = block.parentElement;
        const key = JSON.stringify([selector(clipper), selector(block)]);
        const groups = clipGroups.get(key) ?? {};
        if (overflow <= (groups[axis]?.overflowPx ?? 0)) continue;
        groups[axis] = {
          selector: selector(clipper), textSelector: selector(owner), axis,
          overflowPx: overflow, clipStart: round(start), clipEnd: round(end),
          textStart: round(textStart), textEnd: round(textEnd),
        };
        clipGroups.set(key, groups);
      }
    }
  }
  for (const group of clipGroups.values()) snapshot.clips.push(...Object.values(group));

  for (const el of prefix ?? all) {
    if (!included(el)) continue;
    const rect = box(el);
    if (!rect.width || !rect.height) continue;
    if (rect.y < innerHeight && rect.y + rect.height > 0 && rect.x >= 0 && rect.x + rect.width <= width &&
        el.matches('button:enabled, input:enabled:not([type=hidden]), select:enabled, textarea:enabled, [role="button"]:not([aria-disabled=true])')) {
      snapshot.hitControls.push(selector(el));
    }
    const bands = lineBands.get(el);
    if (bands) {
      const key = el.getAttribute('data-localeguard-key');
      const control: Control = { selector: selector(el), rect, kind: el.localName + '/' + (el.getAttribute('role') ?? ''),
        key: key ? 'key:' + key : 'id:' + el.id, lines: countLines(bands) };
      for (const other of [el.previousElementSibling, el.nextElementSibling]) {
        if (!other?.matches(actionSelector) || !included(other)) continue;
        const r = other.getBoundingClientRect();
        const w = Math.min(rect.x + rect.width, r.right) - Math.max(rect.x, r.left);
        const h = Math.min(rect.y + rect.height, r.bottom) - Math.max(rect.y, r.top);
        if (w >= 8 && h >= 8) { control.overlap = { selector: selector(other), width: round(w), height: round(h) }; break; }
      }
      snapshot.controls.push(control);
    }
    if (rect.x >= 0 && rect.x + rect.width <= width) continue;
    if (!el.matches('img, svg, video, canvas, input, select, textarea, button, a[href]') &&
        !Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) &&
        style(el).backgroundColor === 'rgba(0, 0, 0, 0)') continue;
    let contained = false;
    for (let parent = el.parentElement; parent && parent !== body && parent !== root; parent = parent.parentElement) {
      if (style(parent).overflowX !== 'visible') { contained = true; break; }
    }
    if (contained) continue;
    const candidate: ElementBox = { selector: selector(el), rect };
    if (rect.x + rect.width <= 0 || rect.x >= width) {
      if (el instanceof HTMLAnchorElement && el.tabIndex >= 0 && el.hash.length > 1 &&
          el.origin === location.origin && el.pathname === location.pathname && el.search === location.search &&
          document.getElementById(el.hash.slice(1))) {
        candidate.reveal = { trigger: candidate.selector, state: 'focus' };
      } else if (['fixed','absolute'].includes(style(el).position) &&
          (el.matches('nav,[role=navigation]') || el.querySelector('nav,[role=navigation]'))) {
        const trigger = el.parentElement?.querySelector(':scope > input[type=checkbox]:enabled:not(:checked)[aria-expanded=false]');
        if (trigger instanceof HTMLInputElement && [trigger,...Array.from(trigger.labels ?? [])].some(opener => {
          const r = opener.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && included(opener) &&
            opener.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));
        })) {
          candidate.reveal = { trigger: selector(trigger), state: 'checked' };
        }
      }
    }
    snapshot.candidates.push(candidate);
  }
  return snapshot;
}
