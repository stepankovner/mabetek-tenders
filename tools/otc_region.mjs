import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {publicIndex} from '../src/core.mjs';

const market = 'https://market.otc.ru/khabkray';
const listing = 'https://etp.otc.ru/tenders-search/market-habarovskij-kraj/small?IsRegionalVersion=true';

export function activeCount(text) {
  const match = /(?:^|\n)\s*(\d+)\s+количество актуальных закупок(?:\s|$)/iu.exec(text);
  if (!match) throw Error('Нет счётчика закупок региона');
  return Number(match[1]);
}

export async function collect(page) {
  await page.goto(market, {waitUntil:'domcontentloaded', timeout:30000});
  await page.getByText('количество актуальных закупок', {exact:true}).first().waitFor();
  const count = activeCount(await page.locator('body').innerText());
  await page.goto(listing, {waitUntil:'domcontentloaded', timeout:30000});
  await page.getByText('Тендеры на площадке Market Хабаровский край закупки малого объема', {exact:true}).first().waitFor();
  const links = page.locator('a[href*="/tender/"]');
  if (!count && !(await links.count())) return [];
  await links.first().waitFor({timeout:12000});
  const cards = publicIndex('otc', await page.content());
  if (cards.length !== count) throw Error('Число активных карточек расходится со статистикой региона');
  return cards.map(card => ({...card, source:'otc-khab', procedure:new URL(card.url).pathname.split('/').pop(), lot:'1'}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const require = createRequire(import.meta.url);
  const {chromium} = require(require.resolve('playwright-core',{paths:[process.cwd(),new URL('../../frontend/',import.meta.url).pathname]}));
  const browser = await chromium.launch({channel:'chrome'});
  try { console.log(JSON.stringify(await collect(await browser.newPage()))); }
  finally { await browser.close(); }
}
