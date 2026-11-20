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
  const documents=[];
  for(const [,tr] of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
    const link=tr.match(/href=["'](https:\/\/223\.rts-tender\.ru\/files\/FileDownloadHandler\.ashx\?FileGuid=[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})["']/i)?.[1];
    const name=tr.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    if(link && /\.(?:docx?|xlsx?|pdf|zip)$/i.test(name) && !documents.some(d=>d.url===link))documents.push({name,url:link});
  }
  return {...(documents.length?{documents}:{}),source:'rzd-rts',procedure:u.searchParams.get('tenderId'),lot:'процедура',title,customer,place:get('Место поставки'),region:get('Регион'),price:get('НМЦ'),deadline:get('Дата окончания подачи заявок'),status:get('Статус на площадке'),url:u.href};
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
  const anchors=[...html.matchAll(/<a\b[^>]*\bhref=["']([^"']+\/tender-(\d+)\/(?:[?#][^"']*)?)["']/gi)];
  for(const [i,a] of anchors.entries()){
    const url=new URL(a[1].replace(/&amp;/g,'&'),'https://www.b2b-center.ru');
    if(url.origin!=='https://www.b2b-center.ru' || !/^\/(?:app\/market-next|market)\//.test(url.pathname))continue;
    const block=html.slice(a.index+a[0].length,anchors[i+1]?.index??html.length);
    const raw=block.match(/<p\b[^>]*class=["'][^"']*\bpanel-procedure__dscr-main\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1];
    const title=raw?.replace(/<[^>]+>/g,'').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
    const item=unique.get(a[2])||{id:a[2],url:url.origin+url.pathname};
    if(title)item.title=title;
    unique.set(a[2],item);
  }
  if(!unique.size && !/(?:ничего не найдено|по вашему запросу\s+нет актуальных процедур|по вашему запросу.*не найдено)/i.test(html))throw Error('Не распознана выдача B2B-Center');
  return [...unique.values()];
}

export function b2bTitle(html,id) {
  const element = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!element || !/^\d+$/.test(id)) throw Error('Нет заголовка оригинала');
  const parts = element[1].split(/\s+[—–]\s+(?:Тендер|Закупка|Лот)\s*№\s*/i);
  if (parts.length !== 2 || parts[1].match(/^\d+/)?.[0] !== id) throw Error('Нет заголовка оригинала');
  const title = parts[0].replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
  if (!title) throw Error('Нет заголовка оригинала');
  return title;
}

export const publicCatalogues={
  roseltorg:{name:'Росэлторг',url:'https://www.roseltorg.ru/procedures/search'},
  tektorg:{name:'ТЭК-Торг',url:'https://www.tektorg.ru/procedures'},
  gpb:{name:'ЭТП ГПБ',url:'https://etpgpb.ru/procedures/'}
};

export function publicIndex(source,html) {
  const catalogue=publicCatalogues[source];
  const found=new Map();
  for(const [,attrs,body] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)){
    const href=attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if(!href)continue;
    let url;
    try{url=new URL(href,catalogue.url);}catch{continue;}
    if(url.protocol!=='https:'||url.username||url.password||url.port)continue;
    if(source==='roseltorg' && !(url.hostname==='www.roseltorg.ru' && /^\/procedure\/[\w-]+(?:\/\d+)?\/?$/.test(url.pathname) && attrs.includes('search-results__link--description')))continue;
    if(source==='tektorg' && !(url.hostname==='www.tektorg.ru' && /^\/(?:org\/[\w-]+\/)?procedures\/\d+\/?$/.test(url.pathname)))continue;
    if(source==='gpb' && !(/^([a-z0-9-]+\.)?etpgpb\.ru$/.test(url.hostname) && /^\/front\/procedure\/view\/[\da-f-]+\/?$/i.test(url.pathname) && attrs.includes('vTitle')))continue;
    const title=body.replace(/<!--[\s\S]*?-->|<[^>]+>/g,'').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
    if(title.length<5 || /^№\s*[\w-]+$/.test(title))continue;
    const canonical=url.origin+url.pathname;
    found.set(canonical,{url:canonical,title});
  }
  if(!found.size)throw Error('Не распознана выдача '+catalogue.name);
  return [...found.values()];
}

export function serviceMatch(subject){
  const normal=subject.toLowerCase().replace(/ё/g,'е').replace(/ж\s*[/.-]\s*д/g,'жд');
  return /(?:выгруз|разгруз|погруз|перевал|перегруз).{0,60}(?:вагон|груз)|погрузочно[-\s]разгрузоч|(?:прием|постановк).{0,35}вагон|(?:аренд|предоставлен).{0,55}(?:тупик|пут[иея]).{0,25}(?:железнодорож|необщего пользования)|хранени.{0,30}(?:с жд|с железнодорож)|(?:склад|площадк).{0,40}подъездн.{0,15}пут/u.test(normal);
}
