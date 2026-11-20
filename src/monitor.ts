import {b2bIndex} from './core.mjs';
const catalog='https://www.b2b-center.ru/app/next/market-search/';
const service=/tupik|vagon|perevalk|pod[ie]ezdn|zheleznodorozhn|pogruz|vygruz|sklad|khraneni|terminal/i;
async function page(url:string){
  const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(12000)});
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
    const rows=b2bIndex(await page(catalog));
    const batch=[];
    for(const c of rows){
      // The actual title is obtained from the original, never reconstructed from a slug.
      const old=await q('SELECT url FROM notices WHERE url=?',c.url).first();
      if(old||!service.test(c.url))continue;
      const detail=await page(c.url);
      const title=detail.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      if(!title)throw Error('Нет заголовка оригинала');
      batch.push(q("INSERT OR IGNORE INTO notices(url,title,description) VALUES(?,?,'B2B-Center · место и документы требуют проверки')",c.url,title));
      batch.push(q("INSERT OR IGNORE INTO outbox(dedupe,owner,payload) SELECT ?,id,? FROM owner",'b2b/'+c.id,JSON.stringify({text:'Подборка B2B-Center · проверить место исполнения\n'+title+'\n'+c.url})));
      if(batch.length>=4)break;
    }
    batch.push(q("UPDATE sources SET last_ok=unixepoch(),cursor=?,last_error=NULL WHERE id='b2b'",'Первая страница: '+rows.length+' процедур'));
    await e.DB.batch(batch);
  }catch(err){
    const reason=err instanceof Error && /^(HTTP \d+|Не распознана|Нет заголовка|Лимит размера)/.test(err.message)?err.message:'Источник недоступен с Worker';
    await q("UPDATE sources SET last_error=? WHERE id='b2b'",reason).run();
  }
}
