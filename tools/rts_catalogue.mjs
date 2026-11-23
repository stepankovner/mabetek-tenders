import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

// Parse only the response to our public search; the previous page may still be visible.
export function readRzdPage({html, number}) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const count = doc.querySelector('input#AllCount')?.value;
  if (!/^\d+$/.test(count || '')) throw Error('РТС не вернула счётчик выдачи');
  const rows = [...doc.querySelectorAll('div.card-item')];
  const remaining = Math.max(0, Number(count) - (number - 1) * 10);
  if (rows.length !== Math.min(10, remaining)) throw Error('Неполная страница РТС');
  const cards = new Map();
  for (const row of rows) {
    const orgs = [...row.querySelectorAll('[itemprop="description"]')];
    if (!orgs.some(el => /ИНН\s*7708503727\b/.test(el.textContent))) continue;
    const links = [...row.querySelectorAll('a[href]')].map(a=>a.getAttribute('href'));
    const original = links.find(u=>/^https:\/\/223\.rts-tender\.ru\/supplier\/auction\/Trade\/View\.aspx\?Id=\d+#\d+$/i.test(u));
    if (!original) continue;
    const deadline = row.querySelector('time[itemprop="availabilityEnds"]')?.getAttribute('datetime') || '';
    const dt = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2}:\d{2})$/.exec(deadline);
    const title = row.querySelector('[data-annotation="PurchaseName"]')?.textContent.trim();
    if (!dt || !title) throw Error('РТС не вернула срок или предмет');
    const end = dt[3]+'-'+dt[2]+'-'+dt[1]+'T'+dt[4]+dt[5];
    if (!Number.isFinite(Date.parse(end))) throw Error('Не распознан срок РТС');
    if (Date.parse(end) <= Date.now()) continue;
    const url = new URL(original);
    const positions = [...new Set([...row.querySelectorAll('table.tru-position-table td.position-counter + td')]
      .map(el => el.textContent.replace(/\s+/g,' ').trim()).filter(Boolean))];
    const eisUrl = links.find(link => /^https:\/\/zakupki\.gov\.ru\/epz\/order\/notice\/notice223\/common-info\.html\?regNumber=\d{11}$/.test(link));
    const amount = row.querySelector('[itemprop="price"]')?.getAttribute('content');
    const currency = row.querySelector('[itemprop="priceCurrency"]')?.getAttribute('content');
    const rubles = currency==='RUB' && /^\d+(?:\.\d{1,2})?$/.test(amount || '') && /[1-9]/.test(amount) ? amount : null;
    cards.set(url.href,{source:'rts-rzd-search',procedure:url.searchParams.get('Id'),lot:url.hash.slice(1),url:url.href,title,deadline:end,positions,...(eisUrl?{eis_url:eisUrl}:{}),...(rubles?{catalogue_price_rub:rubles}:{})});
  }
  return {count:Number(count), cards:[...cards.values()]};
}

export async function scan(page, {allowPartial=false, limitMs=100000}={}) {
  const started=performance.now();
  const landing = await page.goto('https://www.rts-tender.ru/poisk/', {waitUntil:'domcontentloaded',timeout:30000});
  try {
    await page.getByPlaceholder('Введите ключевое слово или номер извещения').fill('РЖД',{timeout:30000});
  } catch (error) {
    if (landing?.status() === 503 && /Anti-DDoS/i.test(await page.title())) {
      throw Error('RTS_PUBLIC_SEARCH_UNAVAILABLE');
    }
    throw error;
  }
  const [response] = await Promise.all([
    page.waitForResponse(r=>r.url()==='https://www.rts-tender.ru/poisk/search/ajaxwithfullmodel' &&
      r.request().method()==='POST' && r.request().postDataJSON()?.searchQuery?.includes('РЖД') &&
      r.request().postDataJSON()?.filter?.notificationStatuses?.includes(1),{timeout:30000}),
    page.locator('button.mainButtonSearch').click()
  ]);
  const read = async (result, number) => {
    if (!result.ok()) throw Error('РТС HTTP ' + result.status());
    return page.evaluate(readRzdPage, {html:await result.text(), number});
  };
  const first = await read(response, 1);
  const cards = new Map(first.cards.map(card => [card.url, card]));
  let pages=1;
  let reason=null;
  for (let number = 2; number <= Math.ceil(first.count / 10); number++) {
    const available=Math.min(15000,Math.floor(limitMs-(performance.now()-started)));
    if(allowPartial&&available<=0){
      reason='rts_pagination_incomplete';
      break;
    }
    const timeout=allowPartial?available:15000;
    try{
      await page.waitForFunction(previous =>
        Array.from(document.querySelectorAll('#pager .current')).some(el => el.textContent.trim() === String(previous)),
        number - 1, {timeout});
      const id = new URL(page.url()).searchParams.get('id');
      const [next] = await Promise.all([
        page.waitForResponse(r => {
          if (r.url() !== 'https://www.rts-tender.ru/poisk/Search/LoadPage' || r.request().method() !== 'POST') return false;
          const request = r.request().postDataJSON();
          return request?.page === number && request.id === id;
        }, {timeout}),
        page.locator('#pager a[href="?page=' + number + '"]').first().click({timeout})
      ]);
      const batch = await read(next, number);
      if (batch.count !== first.count) throw Error('Состав выдачи РТС изменился во время обхода');
      for (const card of batch.cards) cards.set(card.url, card);
      pages=number;
    }catch(error){
      if(!allowPartial)throw error;
      reason='rts_pagination_incomplete';
      break;
    }
  }
  return allowPartial?{cards:[...cards.values()],pages,totalPages:Math.max(1,Math.ceil(first.count/10)),reason}:[...cards.values()];
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const require=createRequire(import.meta.url);
  const {chromium}=require(require.resolve('playwright-core',{paths:[process.cwd(),new URL('../../frontend/',import.meta.url).pathname]}));
  const browser=await chromium.launch({channel:'chrome'});
  try { console.log(JSON.stringify(await scan(await browser.newPage(), {allowPartial:process.argv.includes('--partial')}))); }
  finally { await browser.close(); }
}
