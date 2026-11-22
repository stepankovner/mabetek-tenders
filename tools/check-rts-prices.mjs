import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

// Read only the panel belonging to the requested lot. A procedure may contain many different prices.
export function originalRubles(panelText) {
  const match = panelText.replace(/\s+/g,' ').match(/Начальная \(максимальная\) цена\s*:\s*(\d[\d ]*(?:,\d{1,2})?)\s*\(Российский рубль\)/i);
  if (!match) return null;
  const [rubles, kopecks=''] = match[1].replace(/ /g,'').split(',');
  return rubles + '.' + kopecks.padEnd(2,'0');
}

export async function compare(page, cards) {
  const groups = new Map();
  for (const card of cards) {
    if (!/^\d+$/.test(card.procedure) || !/^\d+$/.test(card.lot) ||
        card.url !== 'https://223.rts-tender.ru/supplier/auction/Trade/View.aspx?Id=' + card.procedure + '#' + card.lot)
      throw Error('Номер процедуры или лота не совпадает с оригинальной ссылкой');
    if (!groups.has(card.procedure)) groups.set(card.procedure,[]);
    groups.get(card.procedure).push(card);
  }
  const results = [];
  let blocked = false;
  for (const lots of groups.values()) {
    let reason = blocked ? 'Площадка запросила проверку доступа' : null;
    let panels = {};
    if (!blocked) {
      try {
        const response = await page.goto(lots[0].url,{waitUntil:'load',timeout:20000});
        const path = new URL(page.url()).pathname;
        blocked = /ProtectionProxy/i.test(path) || [403,429,503].includes(response.status());
        if (blocked) reason = 'Площадка запросила проверку доступа';
        else if (!response.ok()) reason = 'HTTP ' + response.status();
        else panels = await page.locator('.h2-lotTitle').evaluateAll(headers=>Object.fromEntries(headers.flatMap(h=>{
          const lot=h.textContent.trim().match(/^Лот\s*№\s*(\d+)$/i);
          const panel=h.closest('.js-tradeLotHeader')?.nextElementSibling;
          return lot && panel?.classList.contains('div-tradeLot') ? [[lot[1],panel.textContent]] : [];
        })));
      } catch { reason = 'Не удалось открыть оригинал'; }
    }
    for (const card of lots) {
      const original = originalRubles(panels[card.lot] || '');
      const catalogue = card.catalogue_price_rub ?? null;
      const [rubles,kopecks=''] = String(catalogue).split('.');
      const match = original!==null && catalogue!==null ? original===rubles+'.'+kopecks.padEnd(2,'0') : null;
      results.push({url:card.url,catalogue,original,match,reason:reason ||
        (original===null?'Сумма лота не подтверждена в оригинале':catalogue===null?'В каталоге нет подтверждённой суммы':null)});
    }
  }
  return results;
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const snapshot = JSON.parse(await readFile(process.argv[2],'utf8'));
  const require = createRequire(import.meta.url);
  const {chromium} = require(require.resolve('playwright-core',{paths:[process.cwd(),new URL('../../frontend/',import.meta.url).pathname]}));
  const browser = await chromium.launch({channel:'chrome'});
  try { console.log(JSON.stringify(await compare(await browser.newPage(),snapshot.cards),null,2)); }
  finally { await browser.close(); }
}
