import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

// This function also runs unchanged in an already-open public catalogue tab.
export function readPublicPage() {
  if (location.origin !== 'https://agregatoreat.ru' || location.pathname !== '/purchases/all')
    throw Error('Не открыт публичный реестр ЕАТ');
  const page = Number(document.querySelector('.p-paginator-page[aria-current="page"]')?.textContent);
  const cards = [...document.querySelectorAll('article.card')];
  if (!Number.isSafeInteger(page) || page < 1 || !cards.length) throw Error('Реестр ЕАТ не загружен');
  const rows = [];
  let restricted = 0, inactive = 0;
  for (const card of cards) {
    const content = card.innerText;
    if (/Войти в профиль\s+для просмотра закупки/i.test(content)) {
      restricted++;
      continue;
    }
    const link = card.querySelector('app-status-link a');
    if (!link?.innerText.trim()) throw Error('Не распознан статус ЕАТ');
    if (link.innerText.trim() !== 'Подача предложений') {
      inactive++;
      continue;
    }
    const number = content.match(/^\s*(\d{18})\b/m)?.[1];
    const title = content.match(/(?:^|\n)Наименование\s*\n([\s\S]*?)\n\s*Заказчик(?:\s|$)/)?.[1]?.trim().replace(/\s+/g,' ');
    const url = link.href;
    if (!number || !title || !/^https:\/\/agregatoreat\.ru\/purchases\/announcement\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\/$/i.test(url))
      throw Error('Не распознана публичная карточка ЕАТ');
    rows.push({number,title,url});
  }
  return {page, cards:cards.length, restricted, inactive, rows};
}

export async function collect(browser, limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Ожидается от 1 до 100 страниц');
  const tab = await browser.newPage();
  try {
    await tab.goto('https://agregatoreat.ru/purchases/all', {waitUntil:'domcontentloaded',timeout:30000});
    const pages = [];
    for (let n=1; n<=limit; n++) {
      if (n>1) {
        const next = tab.locator('button.p-paginator-page[aria-label="'+n+'"]');
        if (!(await next.count())) break;
        const first = await tab.locator('article.card app-status-link a').first().getAttribute('href');
        await next.click({timeout:10000});
        await tab.waitForFunction(prev => {
          const href = document.querySelector('article.card app-status-link a')?.getAttribute('href');
          return href && href !== prev;
        }, first, {timeout:20000});
      }
      await tab.locator('article.card app-status-link a').first().waitFor({timeout:20000});
      const result = await tab.evaluate(readPublicPage);
      if (result.page !== n) throw Error('Страница ЕАТ не переключилась');
      pages.push(result);
    }
    return pages;
  } finally { await tab.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const require = createRequire(import.meta.url);
  const {chromium} = require(require.resolve('playwright-core',{paths:[process.cwd(),new URL('../../frontend/', import.meta.url).pathname]}));
  const browser = await chromium.launch({channel:'chrome'});
  try { console.log(JSON.stringify(await collect(browser,Number(process.argv[2] ?? 1)),null,2)); }
  finally { await browser.close(); }
}
