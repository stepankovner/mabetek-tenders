export function identity(x) {
  if (!x.procedure || !x.lot || !x.source) throw Error('Не определён идентификатор лота');
  return JSON.stringify([x.eis?'eis':x.source,x.eis||x.procedure,String(x.lot)]);
}
export function authorized(chat,from,owner) {
  return chat?.type==='private' && Number.isSafeInteger(from) && from===chat.id && String(from)===owner;
}
export function feed(xml) {
  if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml) || !/<\/channel>\s*<\/rss>\s*$/i.test(xml)) throw Error('Ожидалась выдача RSS');
  function field(item,key) {
    const raw=item.match(new RegExp('<'+key+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+key+'>','i'))?.[1]||'';
    return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<[^>]*>/g,' ').trim();
  }
  const items=[...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  if(items.length!==(xml.match(/<item\b/gi)||[]).length) throw Error('Повреждена запись RSS');
  return items.map(([,item])=>{
    const url=field(item,'link'), title=field(item,'title');
    if(!url || !title || new URL(url).hostname!=='zakupki.gov.ru' || !url.startsWith('https://')) throw Error('Изменился формат извещения');
    return {url,title,description:field(item,'description'),published:field(item,'pubDate')};
  });
}

export function rzdCard(html,url) {
  const u = new URL(url);
  if(u.origin!=='https://rzd.rts-tender.ru' || u.pathname!=='/TenderInterests/LogViewAndRedirect' || !/^\d+$/.test(u.searchParams.get('tenderId')||'')) throw Error('Требуется карточка секции РЖД');
  const lines=html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<\/(?:td|th|div|h[1-6]|span|li|p)>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/&quot;/g,'"').replace(/&amp;/g,'&').split(/\n/).map(s=>s.trim()).filter(Boolean);
  function get(key){const i=lines.findIndex(s=>s.replace(/:$/,'')===key);return i<0?'':lines[i+1]||'';}
  const title=get('Наименование'),customer=get('Заказчик');
  if(!title||!customer||!get('Площадка')) throw Error('Не распознана карточка РЖД');
  return {source:'rzd-rts',procedure:u.searchParams.get('tenderId'),lot:'процедура',title,customer,place:get('Место поставки'),region:get('Регион'),price:get('НМЦ'),deadline:get('Дата окончания подачи заявок'),status:get('Статус на площадке'),url:u.href};
}

// The RZD procurement section publishes its clocks in Moscow time (UTC+3).
export function rzdTime(raw) {
  const m=String(raw||'').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?:\s+МСК)?$/i);
  const unknown={original:raw,utc:null,khabarovsk:null};
  if(!m || +m[4]>23 || +m[5]>59)return unknown;
  const ms=Date.UTC(+m[3],+m[2]-1,+m[1],+m[4]-3,+m[5]);
  function local(h){
    const d=new Date(ms+h*3600000).toISOString();
    return d.slice(8,10)+'.'+d.slice(5,7)+'.'+d.slice(0,4)+' '+d.slice(11,16);
  }
  if(local(3)!==m[1]+'.'+m[2]+'.'+m[3]+' '+m[4]+':'+m[5])return unknown;
  return {original:raw,utc:new Date(ms).toISOString(),moscow:local(3),khabarovsk:local(10)};
}

export function b2bIndex(html) {
  const unique=new Map();
  for(const a of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+\/tender-(\d+)\/(?:\?[^"']*)?)["']/gi)){
    const url=new URL(a[1].replace(/&amp;/g,'&'),'https://www.b2b-center.ru');
    if(url.origin!=='https://www.b2b-center.ru' || !/^\/(?:app\/market-next|market)\//.test(url.pathname))continue;
    unique.set(a[2],{id:a[2],url:url.origin+url.pathname});
  }
  if(!unique.size && !/(?:ничего не найдено|по вашему запросу.*не найдено)/i.test(html))throw Error('Не распознана выдача B2B-Center');
  return [...unique.values()];
}
