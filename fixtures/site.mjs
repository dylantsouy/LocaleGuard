import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./site.css', import.meta.url), 'utf8');
const patterns = readFileSync(new URL('./patterns.html', import.meta.url), 'utf8');
const typography = readFileSync(new URL('./typography.html', import.meta.url), 'utf8');
const reliability = readFileSync(new URL('./reliability.html', import.meta.url), 'utf8');
const reliabilityLabels = {
  en: { jump: 'Skip to content', menu: 'Browse', terms: 'Terms of use', contact: 'Contact the library' },
  de: { jump: 'Zum Inhalt springen', menu: 'Menü öffnen', terms: 'Nutzungsbedingungen', contact: 'Bibliothek kontaktieren' },
  ja: { jump: '本文へ移動', menu: 'メニューを開く', terms: '利用規約', contact: '図書館へのお問い合わせ' },
};

const copy = {
  en: {
    catalog: 'Field guides', checkout: 'Order review', edition: 'Autumn edition',
    title: 'Walking the coast', category: 'Travel', tab: 'Contents', confirm: 'Confirm',
    note: 'A printed copy will be sent to your shipping address after payment.',
    options: 'Options', banner: 'Shipping included', link: 'Delivery details',
  },
  de: {
    catalog: 'Reiseführer', checkout: 'Bestellübersicht', edition: 'Herbstausgabe',
    title: 'Wandern entlang der Küste', category: 'Reisen', tab: 'Inhalt',
    confirm: 'Zahlungspflichtig bestellen', note: 'Nach der Zahlung wird ein gedrucktes Exemplar an Ihre angegebene Lieferadresse versendet.',
    options: 'Alle verfügbaren Lieferoptionen anzeigen', banner: 'Versand inklusive', link: 'Lieferdetails',
  },
};

function documentFor(language, page) {
  const t = copy[language];
  const checkout = page === 'checkout';
  const broken = checkout && language === 'de';
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t[page]} · Atlas Press</title><link rel="stylesheet" href="/site.css"></head>
<body class="${broken ? 'broken' : ''}"><main><header><strong>Atlas Press</strong><span>${t.edition}</span></header>
<h1>${t[page]}</h1><section class="book"><p>${t.category}</p><h2>${t.title}</h2>
<p id="edition-preview" class="ellipsis">${t.title} · ${t.edition} · Atlas Press</p></section>
${checkout ? `<section class="order"><h2>${t.link}</h2><p id="delivery-note"><span>${t.note}</span></p>
<button id="confirm-order"><span>${t.confirm}</span></button>
<button id="delivery-options" data-localeguard-key="delivery-options">${t.options}</button>
<p id="shipping-banner">${t.banner}</p></section>` :
`<section><h2>${t.tab}</h2><div class="rail" aria-label="${t.tab}">
${[1, 2, 3, 4, 5, 6].map(i => `<span>${t.tab} ${i}</span>`).join('')}</div>
<p class="clamp">${(t.note + ' ').repeat(4)}</p>
<div class="carousel" aria-roledescription="carousel"><div>${t.title}</div><div>${t.edition}</div></div>
<div class="carousel"><div>${t.tab} 1</div><div>${t.tab} 2</div></div></section>`}
<aside hidden><span class="away">Hidden</span></aside>
<div class="sr">Atlas Press</div>
</main></body></html>`;
}

export function createFixtureServer() {
  return createServer((req, res) => {
    if (req.url === '/typography') {
      res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
      return res.end(typography);
    }
    const reliabilityPage = /^\/(en|de|ja)\/reliability$/.exec(req.url ?? '');
    if (reliabilityPage) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const lang = reliabilityPage[1];
      const labels = {lang, ...reliabilityLabels[lang]};
      return res.end(reliability.replace(/\{(lang|jump|menu|terms|contact)\}/g, (_, key) => labels[key]));
    }
    const patternPage = /^\/(en|de)\/patterns$/.exec(req.url ?? '');
    if (patternPage) {
      const lang = patternPage[1];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(patterns.replaceAll('{lang}', lang).replaceAll('{action}',
        lang === 'en' ? 'Order' : 'Alle verfügbaren Optionen für die Lieferung anzeigen'));
    }
    if (req.url === '/site.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      return res.end(css);
    }
    const match = /^\/(en|de)\/(catalog|checkout)$/.exec(req.url ?? '');
    if (!match) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Page not found');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(documentFor(match[1], match[2]));
  });
}
