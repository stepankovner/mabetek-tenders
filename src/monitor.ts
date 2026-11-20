import {b2bIndex,b2bTitle,publicCatalogues,publicIndex,serviceMatch} from './core.mjs';
const catalog='https://www.b2b-center.ru/app/next/market-search/';
const queries=['погрузочно-разгрузочные','перевалка','железнодорожный тупик','ответственное хранение','постановка вагонов','путь необщего пользования'];
const construction=/^(?:устройство|ремонт|строительство|реконструкция|поставка запасных частей)(?:\s|$)/iu;
class RateLimit extends Error {
  retryAt:number;
  constructor(header:string|null){
    super('HTTP 429');
    const now=Math.ceil(Date.now()/1000);
    const requested=header && /^\d+$/.test(header) ? now+Number(header) : Date.parse(header||'')/1000;
    this.retryAt=Number.isSafeInteger(requested)?Math.max(now+900,requested):now+900;
  }
}
async function page(url:string){
  const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(12000)});
  if(r.status===429)throw new RateLimit(r.headers.get('Retry-After'));
  if(!r.ok)throw Error('HTTP '+r.status);
  const reader=r.body!.getReader(),decoder=new TextDecoder();
  let html='',n=0;
  for(;;){const b=await reader.read();if(b.done)break;n+=b.value.length;if(n>3000000){await reader.cancel();throw Error('Лимит размера');}html+=decoder.decode(b.value,{stream:true});}
  return html+decoder.decode();
}
export async function b2b(e:any){
  const q=(s:string,...p:unknown[])=>e.DB.prepare(s).bind(...p);
  await q("INSERT OR IGNORE INTO sources(id,url) VALUES('b2b',?)",catalog).run();
  const source=await q("UPDATE sources SET next_at=unixepoch()+900 WHERE id='b2b' AND next_at<=unixepoch() RETURNING cursor").first();
  if(!source)return;
  try{
    const previous=Number(source.cursor);
    const index=Number.isInteger(previous)&&previous>=0&&previous<queries.length?previous:0;
    const search=new URL(catalog);
    search.search=new URLSearchParams({q:queries[index],fz_type:'all',company_type:'2',include_firm_tree:'false',sort:'date_desc',trade:'buy',show:'actual'}).toString();
    const rows=b2bIndex(await page(search.href));
    const batch=[];
    for(const c of rows){
      // The actual title is obtained from the original, never reconstructed from a slug.
      const old=await q('SELECT url FROM notices WHERE url=?',c.url).first();
      if(old)continue;
      const title=c.title||b2bTitle(await page(c.url),c.id);
      batch.push(q("INSERT OR IGNORE INTO notices(url,title,description) VALUES(?,?,'B2B-Center · место и документы требуют проверки')",c.url,title));
      if(!construction.test(title))batch.push(q("INSERT OR IGNORE INTO outbox(dedupe,owner,payload) SELECT ?,id,? FROM owner",'b2b/'+c.id,JSON.stringify({text:'Подборка B2B-Center · проверить место исполнения\n'+title+'\n'+c.url})));

    }
    batch.push(q("UPDATE sources SET last_ok=unixepoch(),cursor=?,last_error=NULL WHERE id='b2b'",String((index+1)%queries.length)));
    await e.DB.batch(batch);
  }catch(err){
    const reason=err instanceof Error && /^(HTTP \d+|Не распознана|Нет заголовка|Лимит размера)/.test(err.message)?err.message:'Источник недоступен с Worker';
    const retryAt=err instanceof RateLimit?err.retryAt:0;
    await q("UPDATE sources SET last_error=?,next_at=max(next_at,?) WHERE id='b2b'",reason,retryAt).run();
  }
}

export async function publicPoll(e:any,source:keyof typeof publicCatalogues){
  const catalogue=publicCatalogues[source];
  const q=(s:string,...params:unknown[])=>e.DB.prepare(s).bind(...params);
  await q('INSERT OR IGNORE INTO sources(id,url) VALUES(?,?)',source,catalogue.url).run();
  const due=await q('UPDATE sources SET next_at=unixepoch()+900 WHERE id=? AND next_at<=unixepoch() RETURNING id',source).first();
  if(!due)return;
  try{
    const rows=publicIndex(source,await page(catalogue.url));
    const statements=[];
    for(const row of rows.filter(r=>serviceMatch(r.title)&&!construction.test(r.title))){
      statements.push(q('INSERT OR IGNORE INTO notices(url,title,description) VALUES(?,?,?)',row.url,row.title,catalogue.name));
      const message=catalogue.name+' · проверить место исполнения\n'+row.title.slice(0,600)+'\n'+row.url;
      statements.push(q('INSERT OR IGNORE INTO outbox(dedupe,owner,payload) SELECT ?,id,? FROM owner',row.url,JSON.stringify({text:message})));
    }
    statements.push(q('UPDATE sources SET last_ok=unixepoch(),last_error=NULL,cursor=? WHERE id=?','Первая страница: '+rows.length,source));
    await e.DB.batch(statements);
  }catch(err){
    const reason=err instanceof Error && /^(HTTP \d+|Не распознана|Лимит размера)/.test(err.message)?err.message:'Источник недоступен с Worker';
    await q('UPDATE sources SET last_error=?,next_at=max(next_at,?) WHERE id=?',reason,err instanceof RateLimit?err.retryAt:0,source).run();
  }
}
