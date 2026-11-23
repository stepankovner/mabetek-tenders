import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {publicIndex} from '../src/core.mjs';

const origin = 'https://etp.otc.ru';
const headings = {small:'Тендеры закупки малого объема', commercial:'Тендеры коммерческие'};
const pageSize = 20;

export function catalogPage(section, number, view, html) {
  const summary = /^По запросу найден[оа]? ([\d\s\u00a0\u202f]+) тендер/u.exec(view.summary);
  if (view.heading !== headings[section] || !summary) throw Error('ОТС не вернула подтверждённую выдачу');
  const total = Number(summary[1].replace(/\s/g, ''));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (!Number.isSafeInteger(total) || pages>2000 || number > pages
      || view.activePage !== (pages > 1 ? String(number) : '')
      || view.rows !== Math.min(pageSize, Math.max(0, total - (number - 1) * pageSize))) {
    throw Error('ОТС не подтвердила номер или состав страницы');
  }
  return {pages, cards: total ? publicIndex('otc', html) : []};
}

async function readPage(page, section, number) {
  const url = new URL('/tenders-search/' + section + '/', origin);
  if (number !== 1) url.searchParams.set('page', String(number));
  const response = await page.goto(url.href, {waitUntil:'domcontentloaded', timeout:12000});
  if (response?.status() === 429) {
    const value = (await response.headerValue('retry-after')) || '';
    const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value)-Date.now())/1000);
    throw Object.assign(Error('ОТС HTTP 429'), {retryAfter:Number.isSafeInteger(seconds) && seconds > 0 ? Math.max(seconds,900) : 900});
  }
  if (!response?.ok() || page.url() !== url.href) throw Error('ОТС не вернула ожидаемый каталог');
  await page.getByRole('heading', {name:headings[section],exact:true}).waitFor({timeout:9000});
  const view = await page.evaluate(() => ({
    heading:document.querySelector('h1')?.textContent.trim(),
    summary:[...document.querySelectorAll('h2')].map(x=>x.textContent.trim()).find(x=>x.startsWith('По запросу '))||'',
    activePage:document.querySelector('button[class*="Pager_pagerButton"]:disabled')?.textContent.trim()||'',
    rows:document.querySelectorAll('[class*="TenderItem-module_paper_"]').length,
  }));
  return catalogPage(section, number, view, await page.content());
}

export async function scan(page, section, cursor, pending, limitMs=100000) {
  if (!Object.hasOwn(headings,section) || !Number.isSafeInteger(cursor) || cursor < 2)
    throw Error('Неизвестная секция или курсор ОТС');
  const started = performance.now();
  const first = await readPage(page, section, 1);
  const failed = new Set(pending.filter(n=>n>1&&n<=first.pages));
  const tail = cursor <= first.pages ? cursor : 2;
  const planned = new Set([...failed, ...Array.from({length:Math.max(0,first.pages-tail+1)},(_,i)=>tail+i)]);
  const cards = new Map(first.cards.map(c=>[c.url,c]));
  let next = tail, pageCount = 1, retryAfter = 0;
  const attempted = new Set();
  for (const n of planned) {
    if (performance.now() - started > limitMs) break;
    try{
      const result = await readPage(page,section,n);
      for (const card of result.cards) cards.set(card.url,card);
      failed.delete(n);
      pageCount++;
    }catch(error){
      failed.add(n);
      if (error.retryAfter){retryAfter=error.retryAfter;break;}
    }
    attempted.add(n);
    while (attempted.has(next)) next++;
  }
  const complete = next>first.pages && !failed.size;
  return {section, cards:[...cards.values()], pages:pageCount, totalPages:first.pages,
          next:next>first.pages?2:next, gaps:[...failed], complete, retryAfter};
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [section,cursor,pending]=process.argv.slice(2);
  const require=createRequire(import.meta.url);
  const {chromium}=require(require.resolve('playwright-core',{paths:[process.cwd(),new URL('../../frontend/',import.meta.url).pathname]}));
  const browser=await chromium.launch({channel:'chrome'});
  try {
    const result=await scan(await browser.newPage(),section,Number(cursor),JSON.parse(pending));
    console.log(JSON.stringify(result));
  } catch(error){
    if(!error.retryAfter)throw error;
    console.log(JSON.stringify({section,retryAfter:error.retryAfter,blocked:true}));
  } finally {await browser.close();}
}
