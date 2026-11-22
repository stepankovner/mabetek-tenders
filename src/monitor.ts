import {b2bIndex,b2bTitle,rosneftPage,publicCatalogues,publicIndex,catalogueMatch,construction,infrastructureOnly,eisOrderNumber} from './core.mjs';
const catalog='https://www.b2b-center.ru/app/next/market-search/';
const queries=['погрузочно-разгрузочные','перевалка','железнодорожный тупик','ответственное хранение','постановка вагонов','путь необщего пользования'];
class RateLimit extends Error {
  retryAt:number;
  constructor(header:string|null){
    super('HTTP 429');
    const now=Math.ceil(Date.now()/1000);
    const requested=header && /^\d+$/.test(header) ? now+Number(header) : Date.parse(header||'')/1000;
    this.retryAt=Number.isSafeInteger(requested)?Math.max(now+900,requested):now+900;
  }
}
async function page(url:string, options:RequestInit={}){
  const signal=AbortSignal.timeout(12000);
  let r=await fetch(url,{...options,redirect:'manual',signal});
  if(!options.method && [301,302,307,308].includes(r.status) && r.headers.get('Location')){
    const original=new URL(url);
    const target=new URL(r.headers.get('Location')!,original);
    if(target.origin===original.origin && !target.username && !target.password && target.pathname.replace(/\/$/,'')===original.pathname.replace(/\/$/,'') && target.href!==original.href){
      await r.body?.cancel();
      r=await fetch(target.href,{redirect:'manual',signal});
    }
  }
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
      const old=await q('SELECT title,published FROM notices WHERE url=?',c.url).first();
      if(old && (!c.title || old.title===c.title) && (!c.published || old.published===c.published))continue;
      const title=c.title||old?.title||b2bTitle(await page(c.url),c.id);
      batch.push(q("INSERT INTO notices(url,title,description,published) VALUES(?,?,'B2B-Center · место и документы требуют проверки',?) ON CONFLICT(url) DO UPDATE SET title=excluded.title,published=coalesce(excluded.published,notices.published),updated=max(unixepoch(),updated+1) WHERE title!=excluded.title OR (excluded.published IS NOT NULL AND notices.published IS NOT excluded.published)",c.url,title,c.published||null));
      if(!construction.test(title)&&!infrastructureOnly(title))batch.push(q("INSERT OR IGNORE INTO outbox(dedupe,owner,payload) SELECT ?,id,? FROM owner",'b2b/'+c.id,JSON.stringify({text:'Подборка B2B-Center · проверить место исполнения\n'+title+'\n'+c.url})));

    }
    batch.push(q("UPDATE sources SET last_ok=unixepoch(),cursor=?,last_error=NULL WHERE id='b2b'",String((index+1)%queries.length)));
    await e.DB.batch(batch);
  }catch(err){
    const reason=err instanceof Error && /^(HTTP \d+|Не распознана|Нет заголовка|Лимит размера)/.test(err.message)?err.message:'Источник недоступен с Worker';
    const retryAt=err instanceof RateLimit?err.retryAt:0;
    await q("UPDATE sources SET last_error=?,next_at=max(next_at,?) WHERE id='b2b'",reason,retryAt).run();
  }
}

export function queueEisNotice(e:any,url:string,payload:string){
  const key='eis/'+url;
  const match=/^https:\/\/zakupki\.gov\.ru\/(epz\/order\/notice\/notice223\/(?:view\/)?common-info\.html|223\/purchase\/public\/purchase\/info\/common-info\.html)\?regNumber=(\d{11})$/.exec(url);
  const order=eisOrderNumber(url);
  const message=order?Object.assign(JSON.parse(payload),{reply_markup:{inline_keyboard:[[{text:'Открыть карточку ЕИС'}]]}}):null;
  const expanded=order?"json_set(?, '$.reply_markup.inline_keyboard[0][0].callback_data', '/notice ' || (SELECT rowid FROM notices WHERE url=?))":"?";
  const query='INSERT OR IGNORE INTO outbox(dedupe,owner,payload) SELECT ?,id,'+expanded+' FROM owner';
  const args=order?[key,JSON.stringify(message),url]:[key,payload];
  if(!match)return e.DB.prepare(query).bind(...args);
  const aliases=['epz/order/notice/notice223/common-info.html','epz/order/notice/notice223/view/common-info.html','223/purchase/public/purchase/info/common-info.html']
    .map(path=>'eis/https://zakupki.gov.ru/'+path+'?regNumber='+match[2]);
  return e.DB.prepare(query+' WHERE NOT EXISTS(SELECT 1 FROM outbox WHERE dedupe IN (?,?,?))').bind(...args,...aliases);
}

export function noticeStatements(e:any,source:keyof typeof publicCatalogues | "eat" | "comita-rzd" | "rts-rzd-search" | "otc-khab" | "eis-orders" | "eis-price_requests",rows:{title:string,url:string,published?:string|null}[]){
  const catalogue=source==='eis-orders'?{name:'ЕИС · закупки'}:source==='eis-price_requests'?{name:'ЕИС · запросы цен'}:source==='otc-khab'?{name:'OTC · Хабаровский край'}:source==='eat'?{name:'ЕАТ Берёзка'}:source==='rts-rzd-search'?{name:'РТС · РЖД'}:source==='comita-rzd'?{name:'КОМИТА РЖД · Хабаровский край'}:publicCatalogues[source];
  const q=(s:string,...params:unknown[])=>e.DB.prepare(s).bind(...params);
    const statements=[];
    const notifications:number[]=[];
    for(const row of rows){
      statements.push(q('INSERT INTO notices(url,title,description,published) VALUES(?,?,?,?) ON CONFLICT(url) DO UPDATE SET title=excluded.title,published=coalesce(excluded.published,notices.published),updated=max(unixepoch(),updated+1) WHERE title!=excluded.title OR (excluded.published IS NOT NULL AND notices.published IS NOT excluded.published)',row.url,row.title,catalogue.name,row.published||null));
      if(!catalogueMatch(row.title))continue;
      const message=catalogue.name+' · проверить место исполнения\n'+row.title.slice(0,600)+'\n'+row.url;
      const lot=source==='roseltorg'?new URL(row.url).pathname.match(/^\/procedure\/([\w-]+\/\d+)$/)?.[1]:null;
      const payload=lot&&lot.length<=55?{text:message,reply_markup:{inline_keyboard:[[{text:'Открыть карточку',callback_data:'/ros '+lot}]]}}:{text:message};
      notifications.push(statements.length);
      const serialized=JSON.stringify(payload);
      statements.push(source==='eis-orders'||source==='eis-price_requests'
        ?queueEisNotice(e,row.url,serialized)
        :q('INSERT OR IGNORE INTO outbox(dedupe,owner,payload) SELECT ?,id,? FROM owner',row.url,serialized));
    }
  return {statements,notifications};
}

export async function macCatalogue(e:any,source:keyof typeof publicCatalogues,html:string,error:string){
  const catalogue=publicCatalogues[source];
  const id='mac/'+source;
  let rows:{title:string,url:string,published?:string|null}[]=[];
  let cursor=null;
  if(!error){
    try{
      if(source==='rosneft'){const page=rosneftPage(html);rows=page.rows;cursor=page.cursor;}
      else rows=publicIndex(source,html);
    }
    catch{error='Не распознана публичная выдача на Mac';}
  }
  const {statements,notifications}=noticeStatements(e,source,rows);
  statements.push(e.DB.prepare('INSERT INTO sources(id,url,last_ok,last_error,cursor) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_ok=coalesce(excluded.last_ok,sources.last_ok),last_error=excluded.last_error,cursor=coalesce(excluded.cursor,sources.cursor)').bind(id,catalogue.url,error?null:Math.floor(Date.now()/1000),error||null,cursor));
  const results=await e.DB.batch(statements);
  return {count:rows.length,error:error||null,queued:notifications.some(i=>results[i].meta.changes>0)};
}

export async function publicPoll(e:any,source:keyof typeof publicCatalogues){
  const catalogue=publicCatalogues[source];
  const q=(s:string,...params:unknown[])=>e.DB.prepare(s).bind(...params);
  await q('INSERT OR IGNORE INTO sources(id,url) VALUES(?,?)',source,catalogue.url).run();
  const due=await q('UPDATE sources SET next_at=unixepoch()+900 WHERE id=? AND next_at<=unixepoch() RETURNING cursor',source).first();
  if(!due)return;
  try{
    const result=source==='roseltorg'?await readRoseltorg(due.cursor):source==='rad'?await readRad(due.cursor):source==='rosneft'?await readRosneft(due.cursor):null;
    const section=source==='tektorgRzd'?'rzd':source==='tektorg'?'zakupki':null;
    const body=section?await page('https://api.tektorg.ru/procedures/soap',{
      method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:'"urn:procedures"'},
      body:'<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="https://api.tektorg.ru/procedures/soap"><env:Body><t:procedures><t:exportRequestType><sectionCode>'+section+'</sectionCode><limitPage>12</limitPage><page>1</page><sort><field>datePublished</field><operator>DESC</operator></sort></t:exportRequestType></t:procedures></env:Body></env:Envelope>'
    }):null;
    if(section && !body?.includes('proceduresResponse'))throw Error('Не распознана выгрузка ТЭК-Торг');
    const rows=result?result.rows:publicIndex(source,body??await page(catalogue.url));
    const {statements}=noticeStatements(e,source,rows);
    statements.push(q('UPDATE sources SET last_ok=unixepoch(),last_error=NULL,cursor=? WHERE id=?',result?result.cursor:'Первая страница: '+rows.length,source));
    await e.DB.batch(statements);
  }catch(err){
    const reason=err instanceof Error && /^(HTTP \d+|Не распознана|Лимит размера)/.test(err.message)?err.message:'Источник недоступен с Worker';
    await q('UPDATE sources SET last_error=?,next_at=max(next_at,?) WHERE id=?',reason,err instanceof RateLimit?err.retryAt:0,source).run();
  }
}

async function readRosneft(cursor:string|null){
  const n=Number(cursor);
  const pageNumber=Number.isSafeInteger(n)&&n>0?n:1;
  const url=new URL(publicCatalogues.rosneft.url);
  if(pageNumber>1)url.searchParams.set('page',String(pageNumber));
  return rosneftPage(await page(url.href),pageNumber);
}

async function readRad(cursor:string|null){
  const selection=Number(cursor)||0;
  const cycle=queries.length*2;
  const index=Number.isInteger(selection)&&selection>=0&&selection<cycle?selection:0;
  const url=new URL(publicCatalogues.rad.url);
  const params=new URLSearchParams({
    'filter[*][condition]':'match','filter[*][property]':'*','filter[*][value]':queries[index%queries.length],
    'sort[0][property]':'publicationDateTime','sort[0][direction]':'DESC',limit:'25',offset:'0'
  });
  if(index<queries.length){
    params.set('filter[status][condition]','in');
    params.set('filter[status][property]','status');
    params.set('filter[status][value][0]','accept');
  }
  url.search=params.toString();
  return {rows:publicIndex('rad',await page(url.href)),cursor:String((index+1)%cycle)};
}

async function readRoseltorg(stored:string|null){
  let position={index:0,pages:queries.map(()=>0)};
  if(stored?.startsWith('{')){
    const parsed=JSON.parse(stored);
    if(Number.isInteger(parsed.index)&&parsed.index>=0&&parsed.index<queries.length&&
       Array.isArray(parsed.pages)&&parsed.pages.length===queries.length&&parsed.pages.every((n:number)=>Number.isSafeInteger(n)&&n>=0))position=parsed;
  }
  const index=position.index;
  const current=position.pages[index];
  const collected=new Map<string,{title:string,url:string}>();
  for(const n of current?[0,current]:[0]){
    const u=new URL('https://www.roseltorg.ru/procedures/search_ajax');
    u.search=new URLSearchParams({query_field:queries[index],sale:'1','status[]':'0',page:String(n)}).toString();
    const html=await page(u.href);
    const empty=/Нет результатов,\s*соответствующих всем условиям/i.test(html);
    const rows=empty?[]:publicIndex('roseltorg',html);
    for(const row of rows)collected.set(row.url,row);
    if(n===current){
      const next=[...html.matchAll(/<button\b[^>]*>/gi)].some(([tag])=>tag.includes('pagination__btn--next') && !/\bdisabled\b/.test(tag) && new RegExp('(?:[?&]|&amp;)page='+(n+1)+'(?:[&"\x27]|$)').test(tag));
      position.pages[index]=next?n+1:0;
    }
  }
  position.index=(index+1)%queries.length;
  return {rows:[...collected.values()],cursor:JSON.stringify(position)};
}
