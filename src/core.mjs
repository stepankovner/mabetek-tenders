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
  const lines=html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<\/(?:td|th|div|h[1-6]|span|li|p|a)>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/&quot;/g,'"').replace(/&amp;/g,'&').split(/\n/).map(s=>s.trim()).filter(Boolean);
  function get(key){const i=lines.findIndex(s=>s.replace(/:$/,'')===key);return i<0?'':lines[i+1]||'';}
  const title=get('Наименование'),customer=get('Заказчик');
  if(!title||!customer||!get('Площадка')) throw Error('Не распознана карточка РЖД');
  const documents=[];
  for(const [,tr] of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
    const link=tr.match(/href=["'](https:\/\/223\.rts-tender\.ru\/files\/FileDownloadHandler\.ashx\?FileGuid=[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})["']/i)?.[1];
    const name=tr.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    if(link && /\.(?:docx?|xlsx?|pdf|zip)$/i.test(name) && !documents.some(d=>d.url===link))documents.push({name,url:link});
  }
  const registrations=new Set();
  for(const [,href] of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)){
    let apply;
    try{apply=new URL(href.replace(/&amp;/g,'&'),u);}catch{continue;}
    const number=apply.searchParams.get('registrationNumber')||'';
    if(apply.origin===u.origin && apply.pathname==='/Tenders/Apply' && apply.searchParams.get('tenderId')===u.searchParams.get('tenderId') && /^\d{11}$/.test(number))registrations.add(number);
  }
  const registration=registrations.size===1?[...registrations][0]:null;
  return {...(registration?{registration}:{}),...(documents.length?{documents}:{}),source:'rzd-rts',procedure:u.searchParams.get('tenderId'),lot:'процедура',title,customer,place:get('Место поставки'),region:get('Регион'),price:get('НМЦ'),deadline:get('Дата окончания подачи заявок'),status:get('Статус на площадке'),url:u.href};
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
    const title=raw?.replace(/<[^>]+>/g,'').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&laquo;/g,'«').replace(/&raquo;/g,'»').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
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
  const title = parts[0].replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&laquo;/g,'«').replace(/&raquo;/g,'»').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
  if (!title) throw Error('Нет заголовка оригинала');
  return title;
}

export const publicCatalogues={
  sberWorld:{name:'Сбербанк-АСТ · международная секция',url:'https://world.sberbank-ast.ru/tableForm.aspx?formCode=PurchaseList'},
  roseltorg:{name:'Росэлторг',url:'https://www.roseltorg.ru/procedures/search'},
  tektorg:{name:'ТЭК-Торг',url:'https://www.tektorg.ru/procedures'},
  gpb:{name:'ЭТП ГПБ',url:'https://etpgpb.ru/procedures/'}
};

export function sberRegistry(html){
  const xml=html.replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  const rows=[];
  for(const [,block] of xml.matchAll(/<Purchase>([\s\S]*?)<\/Purchase>/g)){
    const field=key=>block.match(new RegExp('<'+key+'>([\\s\\S]*?)</'+key+'>','i'))?.[1]?.trim()||'';
    const id=field('PurchaseID'), title=field('PurchaseName'), status=field('purchStatus');
    const link=field('purchHref').replace(/&amp;(?:amp;)?/g,'&');
    if(!/^\d+$/.test(id)||link!=='/documentView.aspx?formCode=PurchaseInfo&id='+id||!title||!status)throw Error('Не распознана карточка Сбербанк-АСТ');
    rows.push({title:title.replace(/&amp;quot;|&quot;/g,'"').replace(/&amp;/g,'&'),url:'https://world.sberbank-ast.ru'+link,status});
  }
  if(!rows.length)throw Error('Не распознан реестр Сбербанк-АСТ');
  return rows;
}
export function publicIndex(source,html) {
  if(source==='sberWorld')return sberRegistry(html).filter(r=>/^(?:Bids submission|Submission of bids|Accepting bids)$/i.test(r.status));

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
    const title=body.replace(/<!--[\s\S]*?-->|<[^>]+>/g,'').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&laquo;/g,'«').replace(/&raquo;/g,'»').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
    if(title.length<5 || /^№\s*[\w-]+$/.test(title))continue;
    const canonical=url.origin+url.pathname;
    found.set(canonical,{url:canonical,title});
  }
  if(!found.size)throw Error('Не распознана выдача '+catalogue.name);
  return [...found.values()];
}

export function serviceMatch(subject){
  const normal=subject.toLowerCase().replace(/ё/g,'е').replace(/ж\s*[/.-]\s*д/g,'жд');
  const handling=/(?:выгруз|разгруз|погруз|перегруз|раскрыти).{0,60}(?:вагон|груз)|перевалк|погрузочно[-\s]разгрузоч|(?:прием|постановк).{0,35}(?:вагон|железнодорожн.{0,12}транспорт)|площадк.{0,24}перегруз/u;
  if(handling.test(normal))return true;
  if(/ремонт|строительств|реконструкц/u.test(normal))return false;
  return /(?:аренд|предоставлен).{0,45}тупик|тупик.{0,25}исполнител|пут[а-яь]{1,4} необщего пользования|хранени.{0,30}(?:с жд|с железнодорож)|(?:склад|площадк).{0,40}подъездн.{0,15}пут/u.test(normal);
}

export function roseltorgCard(html,input){
  const url=new URL(input);
  const path=url.pathname.match(/^\/procedure\/([\w-]+)\/(\d+)\/?$/);
  if(url.origin!=='https://www.roseltorg.ru'||!path)throw Error('Требуется ссылка на конкретный лот Росэлторга');
  const [,procedure,lot]=path;
  const starts=[...html.matchAll(/<div\b[^>]*class=["'][^"']*\blot-page__left-column-lot\b[^"']*["'][^>]*>/gi)];
  const index=starts.findIndex(m=>m[0].includes('data-feature-favorite-lots-procedure-number="'+procedure+'"')&&m[0].includes('data-feature-favorite-lots-lot-number="'+lot+'"'));
  if(index<0)throw Error('Лот не найден в оригинале');
  const tail=html.slice(starts[index].index+starts[index][0].length);
  let depth=1,end=-1;
  for(const tag of tail.matchAll(/<\/?div\b[^>]*>/gi)){
    depth+=tag[0][1]==='/'?-1:1;
    if(depth===0){end=tag.index;break;}
  }
  if(end<0)throw Error('Неполный блок лота');
  const block=tail.slice(0,end);
  const clean=(s='')=>s.replace(/<[^>]+>/g,' ').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ').trim();
  const title=clean(block.match(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i)?.[1]);
  const customer=clean(block.match(/class="[^"]*js-seo-customer-name[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]);
  const rawPlace=clean(block.match(/class="lot-delivery__text[^"]*"[^>]*>\s*<div[^>]*>([\s\S]*?)<\/div>/i)?.[1]);
  if(!title)throw Error('Предмет лота не распознан');
  const amount=block.match(/class="lot-item__sum lot-price"[^>]*>([\s\S]*?)<\/div>/i)?.[1]||'';
  const price=/itemprop="priceCurrency"\s+content="RUB"/.test(amount)?(amount.match(/itemprop="price"\s+content="([\d ]+(?:\.\d{1,2})?)"/)?.[1]||'').replace('.',','):'';
  const registration=clean(block.match(/class="lot-start-registration lot-card-info"[^>]*>([\s\S]*?<\/div>\s*<div[^>]*>[\s\S]*?)<\/div>/i)?.[1]);
  const clock=registration.match(/до\s+(\d{2}\.\d{2}\.)(\d{2}|\d{4})\s+(\d{2}:\d{2})\s*\(МСК\)/i);
  const deadline=clock?clock[1]+(clock[2].length===2?'20':'')+clock[2]+' '+clock[3]+' МСК':'';
  const badge=clean(block.match(/class="lot-status lot-status--[\w-]+"[^>]*>(?:\s*<div[^>]*><\/div>)?([\s\S]*?)<\/div>/i)?.[1]);
  const status=badge.match(/При[её]м заявок|Процедура завершена|Процедура отменена|Работа комиссии|Приостановлена/i)?.[0]||'';
  return {source:'roseltorg',procedure,lot,title,customer,place:/[а-я\d]/i.test(rawPlace)?rawPlace:'',region:'',price,deadline,status,url:url.origin+url.pathname};
}

export const construction=/^(?:устройство|ремонт|строительство|реконструкция|поставка запасных частей)(?:\s|$)/iu;
export function infrastructureOnly(title){
  const subject=title.toLowerCase().replace(/^окпд(?:2|\s*2)?\s*[\d.]+[.:\s]*/u,'').trim();
  // These words describe sale of the asset or preparation of engineering documentation.
  return /^продажа\s+железнодорожных путей(?:\s|[.,;:]|$)/u.test(subject) ||
    /^(?:оказание услуг по разработке|разработка)\s+инструкции о порядке обслуживания движения/u.test(subject);
}
export function catalogueMatch(title){
  // Project names after these phrases describe the buyer's facility.
  const subject=title.toLowerCase().split(/(?:для нужд|в рамках проекта|рамках проекта|для проекта|для объекта)/u)[0].trim();
  const otherService=/(?:контролю за техническим состоянием|очистке от снега|предоставлению спецтехники и автотранспорта)/u;
  if(infrastructureOnly(title)||otherService.test(subject)||construction.test(subject))return false;
  if(/^поставка\s/u.test(subject)&&!/(?:с оказанием услуг|и оказание услуг|и услуги)\s/u.test(subject))return false;
  return serviceMatch(subject);
}
